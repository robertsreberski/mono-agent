import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This opt-in regression reproduces the browser CI lane without a root install
// or any built framework package. Never symlink/copy the worktree's dependencies:
// they are exactly what can mask an undeclared browser dependency.
const source = fileURLToPath(new URL("../", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "mono-webapp-standalone-")));
const app = join(fixture, "packages/web/webapp");
const env = { ...process.env,
  XDG_CACHE_HOME: join(fixture, ".cache"),
  XDG_STATE_HOME: join(fixture, ".state"),
  PLAYWRIGHT_BROWSERS_PATH: join(fixture, ".browsers"),
};
delete env.NODE_PATH;
for (const key of Object.keys(env)) if (/^VITE_[A-Z0-9_]+_SHOTS$/.test(key)) delete env[key];

function run(args) {
  console.log(`\n[standalone] pnpm ${args.join(" ")}`);
  const pnpm = process.env.npm_execpath;
  const result = spawnSync(pnpm ? process.execPath : "pnpm", [...(pnpm ? [pnpm] : []), ...args], {
    cwd: app, env, stdio: "inherit", timeout: 600_000,
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error(`Standalone command failed (${result.status ?? result.signal ?? result.error?.code}): ${args.join(" ")}`), { exitCode: result.status ?? 1 });
  }
}

function sourceDigest(directory, hash = createHash("sha256"), prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) sourceDigest(join(directory, entry.name), hash, `${relative}/`);
    else { hash.update(relative); hash.update(readFileSync(join(directory, entry.name))); }
  }
  return hash;
}

try {
  // A fixture underneath the repository would not isolate Node resolution.
  for (let ancestor = dirname(fixture); ; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, "node_modules"))) throw new Error(`Fixture has ancestor node_modules: ${ancestor}`);
    if (dirname(ancestor) === ancestor) break;
  }
  mkdirSync(app, { recursive: true });
  for (const entry of ["src", "public", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "index.html",
    "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts", "vitest.browser.config.ts", "shared-sources.ts"]) {
    cpSync(join(source, entry), join(app, entry), { recursive: true });
  }
  // These are the frontend's existing pure server helpers, not a framework build.
  mkdirSync(join(fixture, "packages/web/src"), { recursive: true });
  for (const file of ["mcp-app-document.ts", "effort-ladder.ts", "message-cost.ts"]) {
    cpSync(resolve(source, "../src", file), join(fixture, "packages/web/src", file));
  }
  const contracts = join(fixture, "packages/agent-contracts/src");
  mkdirSync(contracts, { recursive: true });
  cpSync(resolve(source, "../../agent-contracts/src/provider-usage.ts"), join(contracts, "provider-usage.ts"));
  console.log(`[standalone] Fixture: ${fixture}`);
  console.log(`[standalone] Source SHA256: ${sourceDigest(join(fixture, "packages")).digest("hex")}`);
  console.log("[standalone] No ancestor node_modules; only canonical contract source, no contracts manifest or dist.");
  // Keep dependency and browser downloads within this disposable fixture too.
  run(["install", "--frozen-lockfile", "--store-dir", join(fixture, ".store")]);
  run(["exec", "playwright", "install", "chromium"]);
  run(["test", "src/shared-sources.test.ts", "src/api.test.ts", "src/components/ProviderUsageMeters.test.tsx", "src/components/AgentSettingsDialog.test.tsx"]);
  run(["run", "typecheck"]);
  run(["run", "build"]);
  run(["run", "test:browser"]);
  console.log("[standalone] PASS: isolated install, unit checks, typecheck, production build and full browser suite.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error?.exitCode ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
  console.log(`[standalone] Removed owned fixture: ${fixture}`);
}
