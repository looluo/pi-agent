import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const iconDir = join(root, "src-tauri", "icons");
const sourceIcon = join(root, "pi-web", "app", "favicon.ico");
mkdirSync(iconDir, { recursive: true });

if (!existsSync(sourceIcon)) {
  throw new Error(`Source icon not found: ${sourceIcon}`);
}

// ---------------------------------------------------------------------------
// CRC32 + PNG chunk helpers
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// PNG decode — extract raw RGBA pixels from an 8-bit non-interlaced RGBA PNG
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIG[i]) throw new Error("Source icon is not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 8 + length + 4;
  }

  if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);
  if (colorType !== 6) throw new Error(`Unsupported color type: ${colorType} (expected 6 = RGBA)`);

  const channels = 4;
  const bytesPerPixel = channels;
  const bytesPerRow = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(width * height * channels);

  let prevRow = new Uint8Array(bytesPerRow);
  let rawOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const row = new Uint8Array(bytesPerRow);

    for (let x = 0; x < bytesPerRow; x++) {
      const byte = raw[rawOffset++];
      const prior = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = prevRow[x];
      const upPrior = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;

      switch (filterType) {
        case 0: row[x] = byte; break;
        case 1: row[x] = (byte + prior) & 0xff; break;
        case 2: row[x] = (byte + up) & 0xff; break;
        case 3: row[x] = (byte + ((prior + up) >> 1)) & 0xff; break;
        case 4: row[x] = (byte + paeth(prior, up, upPrior)) & 0xff; break;
        default: throw new Error(`Unknown filter type: ${filterType}`);
      }
    }

    pixels.set(row, y * bytesPerRow);
    prevRow = row;
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Area-average downscale — box filter, good quality for integer ratios
// ---------------------------------------------------------------------------

function resize(pixels, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const srcY0 = Math.floor(dy * yRatio);
    const srcY1 = Math.min(srcH, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dstW; dx++) {
      const srcX0 = Math.floor(dx * xRatio);
      const srcX1 = Math.min(srcW, Math.floor((dx + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          const idx = (sy * srcW + sx) * 4;
          r += pixels[idx];
          g += pixels[idx + 1];
          b += pixels[idx + 2];
          a += pixels[idx + 3];
          count++;
        }
      }

      const dstIdx = (dy * dstW + dx) * 4;
      dst[dstIdx] = Math.round(r / count);
      dst[dstIdx + 1] = Math.round(g / count);
      dst[dstIdx + 2] = Math.round(b / count);
      dst[dstIdx + 3] = Math.round(a / count);
    }
  }

  return dst;
}

// ---------------------------------------------------------------------------
// PNG encode — raw RGBA pixels → PNG buffer (filter type 0 per row)
// ---------------------------------------------------------------------------

function encodePng(width, height, pixels) {
  const bytesPerRow = width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + bytesPerRow);
    row[0] = 0;
    for (let x = 0; x < bytesPerRow; x++) {
      row[1 + x] = pixels[y * bytesPerRow + x];
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO + ICNS containers
// ---------------------------------------------------------------------------

function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, png } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((item) => item.png)]);
}

function icnsChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
}

function makeIcns(png512) {
  const body = icnsChunk("ic09", png512);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

const sourceBuffer = readFileSync(sourceIcon);
const { width: srcW, height: srcH, pixels: srcPixels } = decodePng(sourceBuffer);

const png32 = encodePng(32, 32, resize(srcPixels, srcW, srcH, 32, 32));
const png128 = encodePng(128, 128, resize(srcPixels, srcW, srcH, 128, 128));
const png256 = encodePng(256, 256, resize(srcPixels, srcW, srcH, 256, 256));

writeFileSync(join(iconDir, "32x32.png"), png32);
writeFileSync(join(iconDir, "128x128.png"), png128);
writeFileSync(join(iconDir, "128x128@2x.png"), png256);
writeFileSync(join(iconDir, "icon.ico"), makeIco([{ size: 32, png: png32 }, { size: 128, png: png128 }, { size: 256, png: png256 }]));
writeFileSync(join(iconDir, "icon.icns"), makeIcns(sourceBuffer));

if (!existsSync(join(iconDir, "icon.ico"))) {
  throw new Error("icon generation failed");
}

console.log(`Generated app icons from ${sourceIcon} (${srcW}x${srcH}) in ${iconDir}`);
