import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "pi-web");
const work = join(root, "dist-build", `pi-web-${process.pid}-${Date.now()}`);
const safeHome = join(work, ".home");
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

function applyPatch(file) {
  run("git", ["apply", "--ignore-space-change", "--whitespace=nowarn", file], {
    cwd: work,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
  });
}

function patchSessionSidebar(file) {
  let text = readFileSync(file, "utf8");

  const titleMarker = "function PiAgentTitle() {";
  if (!text.includes(titleMarker)) throw new Error(`Expected PiAgentTitle marker not found in ${file}`);
  text = text.replace(titleMarker, `function invokeTauri(command: string, args?: Record<string, unknown>) {
  const tauri = (globalThis as typeof globalThis & {
    __TAURI__?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
  }).__TAURI__;
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) throw new Error("Tauri API is not available");
  return invoke(command, args);
}

function PiAgentTitle() {`);

  const componentMarker = `export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, onAtMentions }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);`;
  if (!text.includes(componentMarker)) throw new Error(`Expected SessionSidebar state marker not found in ${file}`);
  text = text.replace(componentMarker, `export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, onAtMentions }: Props) {
  useEffect(() => {
    window.piDesktop = {
      selectDirectory: async () => invokeTauri("select_directory") as Promise<string | null>,
    };
    return () => {
      delete window.piDesktop;
    };
  }, []);

  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);`);

  writeFileSync(file, text);
}

rmSync(work, { recursive: true, force: true });
rmSync(webapp, { recursive: true, force: true });
mkdirSync(dirname(work), { recursive: true });
mkdirSync(resources, { recursive: true });
mkdirSync(safeHome, { recursive: true });

cpSync(source, work, {
  recursive: true,
  filter: (path) => !path.includes(`${source}\\.git`) && !path.includes(`${source}/.git`) && !path.includes("node_modules") && !path.includes(".next"),
});

replaceInFile(join(work, "app", "layout.tsx"), 'title: "Pi Agent Web"', 'title: "Pi Agent App"');
patchSessionSidebar(join(work, "components", "SessionSidebar.tsx"));
applyPatch(join(root, "patches", "pi-web", "auto-session-title.patch"));

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
    HOME: safeHome,
    USERPROFILE: safeHome,
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
