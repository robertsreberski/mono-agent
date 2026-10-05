// Test-only real fs boundaries; no production hooks, providers or tool substitutions.
const fs = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const { join } = require("node:path");
const phase = process.env.MONO_AGENT_FIXTURE_CRASH_PHASE;
const root = process.argv[2];
const realOpen = fs.open, realRename = fs.rename, realRm = fs.rm, readFile = fs.readFile;
let payloads = 0, dirtyRenames = 0, canonicalRenamed = false, stopped = false;
async function stop(at) {
  if (stopped || phase !== at) return;
  stopped = true;
  let counter = 0;
  try { counter = (await readFile(join(root, "effect-count.txt"), "utf8")).trim().split("\n").length; } catch (error) { if (error.code !== "ENOENT") throw error; }
  process.send({ phase: at, counter });
  await new Promise(() => {});
}
fs.open = async (...args) => {
  const handle = await realOpen(...args), path = String(args[0]);
  // Numeric O_CREAT flags are used by immutable publication; a read must not count.
  const writingPending = path.includes("/.pending-turns/") && path.endsWith(".json") && typeof args[1] === "number" && (args[1] & require("node:fs").constants.O_CREAT);
  if (writingPending) {
    payloads += 1;
    if (payloads === 2 && phase === "pending-partial") {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => { await writeFile(Buffer.from(bytes).subarray(0, 17)); await stop("pending-partial"); };
    }
  }
  if (phase === "tool-effect" && path.endsWith(".jsonl")) {
    const write = handle.write.bind(handle);
    handle.write = async (...writeArgs) => {
      const bytes = writeArgs[0];
      if (Buffer.isBuffer(bytes) && bytes.toString().includes('"kind":"tool_result"')
        && bytes.toString().includes('"phase":"returned"')) await stop("tool-effect");
      return await write(...writeArgs);
    };
  }
  const sync = handle.sync.bind(handle);
  handle.sync = async () => {
    await sync();
    if (writingPending && payloads === 2) await stop("pending-file");
    if (path === join(root, ".mono-agent", "history", ".pending-turns") && payloads === 2 && dirtyRenames < 2) await stop("pending-directory");
    if (path.endsWith(".dirty.tmp") && dirtyRenames === 1) await stop("fence-file");
    if (path === join(root, ".mono-agent", "history", ".locks") && dirtyRenames === 2) await stop("fence-directory");
    if (canonicalRenamed && path === join(root, ".mono-agent", "history")) await stop("canonical-directory");
    if (path.endsWith(".jsonl") && ["native-start", "tool-started", "tool-returned-unplaced", "manual-start", "overflow-compaction"].includes(phase)) {
      const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      if (phase === "overflow-compaction" && records.some((record) => record.kind === "compaction")) await stop(phase);
      if (phase === "manual-start" && records.some((record) => record.kind === "turn_start" && record.payload.binding?.reconciliation?.purpose === "compaction")) await stop(phase);
      if (phase === "native-start" && records.some((record) => record.kind === "turn_start" && record.payload.binding?.reconciliation)) await stop(phase);
      if (phase === "tool-started" && records.some((record) => record.kind === "tool_call" && record.payload.admission === "started")
        && !records.some((record) => record.kind === "tool_result")) await stop(phase);
      if (phase === "tool-returned-unplaced" && records.some((record) => record.kind === "tool_result" && record.payload.phase === "returned")) await stop(phase);
    }
  };
  return handle;
};
fs.rename = async (...args) => {
  await realRename(...args);
  const destination = String(args[1]);
  if (destination.endsWith(".dirty.json")) { dirtyRenames += 1; if (dirtyRenames === 2) await stop("fence-rename"); }
  if (destination.endsWith(".history.json")) { canonicalRenamed = true; await stop("canonical-rename"); }
};
fs.rm = async (...args) => {
  await realRm(...args);
  if (canonicalRenamed && String(args[0]).endsWith(".dirty.json")) await stop("fence-cleanup");
  if (canonicalRenamed && String(args[0]).includes("/.pending-turns/")) await stop("payload-cleanup");
};
syncBuiltinESMExports();
