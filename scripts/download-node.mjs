import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { chmod, copyFile, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const nodeVersion = process.env.PI_AGENT_NODE_VERSION ?? "22.13.1";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = join(root, "dist-build", "node");
const outDir = join(root, "src-tauri", "binaries");

function host() {
  if (process.platform === "win32" && process.arch === "x64") {
    return { target: "x86_64-pc-windows-msvc", archive: `node-v${nodeVersion}-win-x64.zip`, nodePath: `node-v${nodeVersion}-win-x64/node.exe`, out: "pi-agent-node-x86_64-pc-windows-msvc.exe" };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { target: "aarch64-apple-darwin", archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`, nodePath: `node-v${nodeVersion}-darwin-arm64/bin/node`, out: "pi-agent-node-aarch64-apple-darwin" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { target: "x86_64-apple-darwin", archive: `node-v${nodeVersion}-darwin-x64.tar.gz`, nodePath: `node-v${nodeVersion}-darwin-x64/bin/node`, out: "pi-agent-node-x86_64-apple-darwin" };
  }
  throw new Error(`Unsupported build platform: ${process.platform} ${process.arch}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

const info = host();
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const out = join(outDir, info.out);
if (existsSync(out) && statSync(out).size > 0) {
  console.log(`Node sidecar already exists: ${out}`);
  process.exit(0);
}

const archive = join(tmp, info.archive);
const url = `https://nodejs.org/dist/v${nodeVersion}/${info.archive}`;
if (!existsSync(archive)) {
  await download(url, archive);
}

const extractDir = join(tmp, "extract");
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

if (info.archive.endsWith(".zip")) {
  run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`]);
} else {
  run("tar", ["-xzf", archive, "-C", extractDir]);
}

const extractedNode = join(extractDir, ...info.nodePath.split("/"));
if (!existsSync(extractedNode)) {
  throw new Error(`Extracted node binary not found: ${extractedNode}`);
}

const pending = join(outDir, `${basename(out)}.tmp`);
await copyFile(extractedNode, pending);
if (process.platform !== "win32") {
  await chmod(pending, 0o755);
}
await rename(pending, out);

console.log(`Prepared Node ${nodeVersion} sidecar for ${info.target}: ${out}`);
