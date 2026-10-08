// Test-only real fs boundaries for the configured switch kill matrix. No
// production hooks: the worker arms this after its setup turns, and each
// labelled durable boundary reports once over IPC, then parks that async chain
// until SIGKILL. The event loop stays alive, so the kill lands AT OR AFTER the
// boundary: the labelled operation is complete, and unrelated in-process work
// (timers, other promise chains) may advance before the signal arrives.
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { basename, dirname, join } = require("node:path");
const target = process.env.MONO_AGENT_FIXTURE_CRASH_PHASE;
const root = process.argv[2], history = join(root, "history");
const realOpen = fs.open, realRename = fs.rename, realRm = fs.rm, realUnlink = fs.unlink;
const seen = new Map();
let stopped = false;
async function stop(label) {
  if (!globalThis.__fixtureArmed || stopped) return;
  // Repeated boundaries are numbered in order, e.g. canonical#2.
  const count = (seen.get(label) ?? 0) + 1; seen.set(label, count);
  const name = count === 1 ? label : `${label}#${count}`;
  if (process.env.MONO_AGENT_FIXTURE_TRACE) process.stderr.write(`boundary ${name}\n`);
  if (name !== target) return;
  stopped = true;
  process.send({ phase: name, calls: globalThis.__fixtureCalls?.() ?? [] });
  await new Promise(() => {});
}
globalThis.__fixtureStop = stop;
function switchLabel(fencePath) {
  const fence = JSON.parse(readFileSync(fencePath, "utf8"));
  const state = JSON.parse(readFileSync(fencePath.replace(/fence\.json$/u, `${fence.payload.generation}.state.json`), "utf8"));
  const last = state.attempts.at(-1);
  if (state.phase === "ready") return "switch-ready";
  if (state.phase === "outgoing" && state.attempts.length === 0) return "switch-intent";
  if (last?.outcome === "started" && last.producer === state.phase) return `attempt-started-${last.producer}`;
  if (last && last.outcome !== "started" && !seen.has(`attempt-finished-${last.producer}`)) return `attempt-finished-${last.producer}`;
  return `switch-${state.phase}`;
}
fs.open = async (...args) => {
  const handle = await realOpen(...args), path = String(args[0]);
  if (path.endsWith(".jsonl")) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (globalThis.__fixtureArmed && readFileSync(path, "utf8").includes("\"kind\":\"model_change\"") && !seen.has(`model-change:${path}`)) {
        seen.set(`model-change:${path}`, 1); await stop("model-change");
      }
    };
  }
  return handle;
};
fs.rename = async (...args) => {
  await realRename(...args);
  const destination = String(args[1]), name = basename(destination);
  if (basename(dirname(destination)) === ".model-switches") {
    if (name.endsWith(".fence.json")) await stop(switchLabel(destination));
    if (name.endsWith(".handoff.json")) await stop("artifact");
  }
  if (dirname(destination) === history && name.endsWith(".history.json")) await stop("canonical");
  if (dirname(destination) === history && name.startsWith(".native-history-op.")) await stop("lifecycle-intent");
  if (basename(dirname(destination)) === ".locks" && name.endsWith(".dirty.json")) await stop("turn-fence");
  if (destination.endsWith(".jsonl") && String(args[0]).includes("stage")) await stop("epoch-published");
};
async function removed(path) {
  const name = basename(path);
  if (basename(dirname(path)) === ".model-switches" && name.endsWith(".fence.json")) await stop("switch-fence-removed");
  if (basename(dirname(path)) === ".model-switches" && name.endsWith(".state.json")) await stop("switch-storage-removed");
  if (dirname(path) === history && name.startsWith(".native-history-op.")) await stop("lifecycle-intent-removed");
  if (dirname(path) === history && name.endsWith(".history.json")) await stop("canonical-removed");
  if (name.endsWith(".jsonl") && path.includes("journals")) await stop("native-removed");
}
fs.rm = async (...args) => { await realRm(...args); await removed(String(args[0])); };
fs.unlink = async (...args) => { await realUnlink(...args); await removed(String(args[0])); };
syncBuiltinESMExports();
