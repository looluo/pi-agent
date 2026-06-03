import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "pi-web");
const work = join(root, "dist-build", `pi-web-${process.pid}-${Date.now()}`);
const resources = join(root, "src-tauri", "resources");
const webapp = join(resources, "webapp");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function replaceInFile(file, search, replacement) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(search)) {
    throw new Error(`Expected text not found in ${file}: ${search}`);
  }
  writeFileSync(file, text.replace(search, replacement));
}

function walkFiles(dir, visit) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function pruneWebapp(dir) {
  const removeDirs = [
    join(dir, "node_modules", "@img"),
    join(dir, "node_modules", "sharp"),
    join(dir, "node_modules", "next", "dist", "compiled", "next-devtools"),
    join(dir, "node_modules", "next", "dist", "compiled", "babel"),
    join(dir, "node_modules", "next", "dist", "compiled", "babel-packages"),
    join(dir, "node_modules", "caniuse-lite"),
    join(dir, "node_modules", "baseline-browser-mapping"),
  ];
  for (const path of removeDirs) {
    rmSync(path, { recursive: true, force: true });
  }

  const removableDirs = new Set(["test", "tests", "__tests__", "docs", "doc", "example", "examples", "benchmark", "benchmarks"]);
  function pruneDirs(current) {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (removableDirs.has(entry.name.toLowerCase())) {
        rmSync(path, { recursive: true, force: true });
      } else {
        pruneDirs(path);
      }
    }
  }
  pruneDirs(join(dir, "node_modules"));

  walkFiles(dir, (path) => {
    if (/\.map$|\.d\.ts$|\.tsbuildinfo$|\.md$|\.markdown$|\.flow$/i.test(path)) {
      unlinkSync(path);
      return;
    }
    if (/\.nft\.json$/i.test(path)) {
      unlinkSync(path);
      return;
    }
    const name = path.split(/[\\/]/).pop()?.toLowerCase();
    if (name && ["license", "license.txt", "license.md", "changelog.md", "readme.md", "readme"].includes(name)) {
      unlinkSync(path);
    }
  });
}

rmSync(work, { recursive: true, force: true });
rmSync(webapp, { recursive: true, force: true });
mkdirSync(dirname(work), { recursive: true });
mkdirSync(resources, { recursive: true });

cpSync(source, work, {
  recursive: true,
  filter: (path) => !path.includes(`${source}\\.git`) && !path.includes(`${source}/.git`) && !path.includes("node_modules") && !path.includes(".next"),
});

replaceInFile(join(work, "app", "layout.tsx"), 'title: "Pi Agent Web"', 'title: "Pi Agent App"');

const nextConfig = join(work, "next.config.ts");
replaceInFile(nextConfig, 'import { join } from "path";', 'import { join, resolve } from "path";');
replaceInFile(
  nextConfig,
  "const nextConfig: NextConfig = {",
  "const nextConfig: NextConfig = {\n  output: \"standalone\",\n  outputFileTracingRoot: resolve(__dirname),"
);

run("npm", ["ci"], { cwd: work });
run("npm", ["run", "build"], {
  cwd: work,
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=4096 --max-semi-space-size=256"].filter(Boolean).join(" "),
    NEXT_PRIVATE_BUILD_WORKER: "1",
  },
});

const standalone = join(work, ".next", "standalone");
if (!existsSync(standalone)) {
  throw new Error("Next standalone output was not created");
}

cpSync(standalone, webapp, { recursive: true });
mkdirSync(join(webapp, ".next"), { recursive: true });
cpSync(join(work, ".next", "static"), join(webapp, ".next", "static"), { recursive: true });
if (existsSync(join(work, "public"))) {
  cpSync(join(work, "public"), join(webapp, "public"), { recursive: true });
}

pruneWebapp(webapp);

writeFileSync(
  join(resources, "metadata.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), appTitle: "Pi Agent App" }, null, 2)
);

console.log(`Prepared Next standalone app at ${webapp}`);
