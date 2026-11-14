// Private entry, not an importable sizing API. The CLI forks this exact file
// with empty execArgv and no NODE_OPTIONS. No product import precedes the pin.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
let ownedOutput;
try {
  if (!import.meta.main || !process.connected || process.execArgv.length || Object.hasOwn(process.env, "NODE_OPTIONS")) throw Error("E2_PROTECTED_SIZING_INVALID");
  const input = new Promise(resolve => process.once("message", resolve));
  const { e2SizingIdentity, assertE2SizingIdentity } = await import("./continuity-e2-sizing-identity.mjs");
  const initial = Object.freeze(await e2SizingIdentity());
  const request = await input;
  if (!request || Object.keys(request).sort().join() !== "output,protocol,replayArm,source,summary" || !["faux-short", "faux-max", "protected-exact", "protected-refusal"].includes(request.summary)) throw Error("E2_PROTECTED_SIZING_INVALID");
  const { runE2Sizing } = await import("./continuity-e2-replay.mjs");
  const report = await runE2Sizing({ ...request, onDiagnostic: value => process.send({ type: "diagnostic", value }) });
  ownedOutput = request.output;
  assertE2SizingIdentity(initial, report.sizingIdentity);
  assertE2SizingIdentity(initial, await e2SizingIdentity());
  // The public/in-process function always writes non-qualifying estimates.
  // Only this clean entry promotes its own successfully measured artifact.
  if (report.qualification !== false) throw Error("E2_PROTECTED_SIZING_INVALID");
  report.qualification = true;
  await writeFile(join(request.output, "sizing.json"), JSON.stringify(report) + "\n", { mode: 0o600 });
  process.send({ type: "result", pid: process.pid, report });
} catch (error) {
  if (ownedOutput) await rm(ownedOutput, { recursive: true, force: true });
  process.exitCode = 1;
  process.send?.({ type: "failure", code: error?.code ?? (typeof error?.message === "string" && /^E2_[A-Z_]+$/u.test(error.message) ? error.message : "E2_PROTECTED_SIZING_INVALID") });
} finally { if (process.connected) process.disconnect(); }
