// Private entry, not an importable sizing API. The CLI forks this exact file
// with empty execArgv and no NODE_OPTIONS. No product import precedes the pin.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorDiagnostic, knownRefusalCode } from "./continuity-e2-diagnostics.mjs";
let ownedOutput;
try {
  if (!import.meta.main || !process.connected || process.execArgv.length || Object.hasOwn(process.env, "NODE_OPTIONS")) throw Error("E2_PROTECTED_SIZING_INVALID");
  const input = new Promise(resolve => process.once("message", resolve));
  const { e2SizingIdentity, assertE2SizingIdentity } = await import("./continuity-e2-sizing-identity.mjs");
  const initial = Object.freeze(await e2SizingIdentity());
  const sizing = await input;
  if (!sizing || Object.keys(sizing).sort().join() !== "output,protocol,replayArm,source,summary" || !["faux-short", "faux-max", "protected-exact", "protected-refusal"].includes(sizing.summary)) throw Error("E2_PROTECTED_SIZING_INVALID");
  const { runE2Sizing } = await import("./continuity-e2-replay.mjs");
  const report = await runE2Sizing({ ...sizing, onDiagnostic: value => process.send({ type: "diagnostic", value }) });
  ownedOutput = sizing.output;
  assertE2SizingIdentity(initial, report.sizingIdentity);
  assertE2SizingIdentity(initial, await e2SizingIdentity());
  // The public/in-process function always writes non-qualifying estimates.
  // Only this clean entry promotes its own successfully measured artifact.
  if (report.qualification !== false) throw Error("E2_PROTECTED_SIZING_INVALID");
  report.qualification = true;
  await writeFile(join(sizing.output, "sizing.json"), JSON.stringify(report) + "\n", { mode: 0o600 });
  process.send({ type: "result", pid: process.pid, report });
} catch (error) {
  if (ownedOutput) await rm(ownedOutput, { recursive: true, force: true });
  process.exitCode = 1;
  process.send?.({ type: "failure", code: knownRefusalCode(error?.code) ?? knownRefusalCode(error?.message) ?? "E2_PROTECTED_SIZING_INVALID", diagnostic: errorDiagnostic(error) });
} finally { if (process.connected) process.disconnect(); }
