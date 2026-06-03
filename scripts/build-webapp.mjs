import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function patchAppShell(file) {
  let text = readFileSync(file, "utf8");
  const originalTopBar = '<div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>';
  if (!text.includes(originalTopBar)) {
    throw new Error(`Expected top bar not found in ${file}`);
  }
  text = text.replace(
    originalTopBar,
    '<div ref={topBarRef} data-tauri-drag-region style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)", paddingRight: 108 }}>'
  );

  const returnMarker = "  return (\n    <>";
  if (!text.includes(returnMarker)) {
    throw new Error(`Expected return marker not found in ${file}`);
  }
  text = text.replace(returnMarker, `${returnMarker}\n    <WindowControls />`);

  text = text.replace("position: \"fixed\", top: 0, right: 0, zIndex: 300,", "position: \"fixed\", top: 0, right: 108, zIndex: 300,");

  const component = `

function WindowControls() {
  const invoke = (globalThis as typeof globalThis & { __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
  const run = (action: "minimize" | "maximize" | "close") => {
    void invoke?.("window_control", { action });
  };
  const buttonStyle = (danger = false): React.CSSProperties => ({
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: "pointer",
    padding: 0,
  });

  return (
    <div style={{ position: "fixed", top: 0, right: 0, height: 36, display: "flex", zIndex: 1000 }}>
      <button title="Minimize" aria-label="Minimize" style={buttonStyle()} onClick={() => run("minimize")}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="9" x2="10" y2="9" /></svg>
      </button>
      <button title="Maximize" aria-label="Maximize" style={buttonStyle()} onClick={() => run("maximize")}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="7" height="7" rx="1" /></svg>
      </button>
      <button title="Close" aria-label="Close" style={buttonStyle(true)} onClick={() => run("close")}
        onMouseEnter={(e) => { e.currentTarget.style.background = "#ef4444"; e.currentTarget.style.color = "white"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; e.currentTarget.style.color = "#ef4444"; }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" /></svg>
      </button>
    </div>
  );
}
`;
  text = `${text}\n${component}`;
  writeFileSync(file, text);
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
patchAppShell(join(work, "components", "AppShell.tsx"));

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

writeFileSync(
  join(resources, "metadata.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), appTitle: "Pi Agent App" }, null, 2)
);

console.log(`Prepared Next standalone app at ${webapp}`);
