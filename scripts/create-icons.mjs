import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const iconDir = join(root, "src-tauri", "icons");
mkdirSync(iconDir, { recursive: true });

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

function makePng(size) {
  const rows = [];
  const center = (size - 1) / 2;
  const radius = size * 0.42;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const offset = 1 + x * 4;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inside = dist <= radius;
      const nx = x / size;
      const ny = y / size;
      const piSymbol =
        nx > 0.25 && nx < 0.75 && ny > 0.28 && ny < 0.40 ||
        nx > 0.33 && nx < 0.45 && ny > 0.36 && ny < 0.72 ||
        nx > 0.55 && nx < 0.67 && ny > 0.36 && ny < 0.72 ||
        nx > 0.28 && nx < 0.47 && ny > 0.25 && ny < 0.33 ||
        nx > 0.53 && nx < 0.72 && ny > 0.25 && ny < 0.33;
      row[offset] = piSymbol ? 255 : inside ? 67 : 0;
      row[offset + 1] = piSymbol ? 255 : inside ? 119 : 0;
      row[offset + 2] = piSymbol ? 255 : inside ? 255 : 0;
      row[offset + 3] = inside ? 255 : 0;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

function makeIcns(png1024) {
  const body = icnsChunk("ic10", png1024);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const png32 = makePng(32);
const png128 = makePng(128);
const png256 = makePng(256);
const png1024 = makePng(1024);

writeFileSync(join(iconDir, "32x32.png"), png32);
writeFileSync(join(iconDir, "128x128.png"), png128);
writeFileSync(join(iconDir, "128x128@2x.png"), png256);
writeFileSync(join(iconDir, "icon.ico"), makeIco([{ size: 32, png: png32 }, { size: 128, png: png128 }, { size: 256, png: png256 }]));
writeFileSync(join(iconDir, "icon.icns"), makeIcns(png1024));

if (!existsSync(join(iconDir, "icon.ico"))) {
  throw new Error("icon generation failed");
}

console.log(`Generated app icons in ${iconDir}`);
