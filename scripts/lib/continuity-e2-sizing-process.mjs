// Qualifying sizing is always delegated, never inferred from mutable argv/env.
// Trust boundary: warm caches and accidental preloads, not a hostile parent
// monkeypatching Node builtins. The CLI imports this binding first.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnosticRecord, errorDiagnostic, knownRefusalCode } from "./continuity-e2-diagnostics.mjs";
const failures = new WeakMap();
// Preserve only the child-sanitized original frame, never an IPC exception stack.
export const e2SizingErrorDiagnostic = error => failures.get(error) ?? errorDiagnostic(error);
export async function runE2SizingProcess(input, onDiagnostic) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const child = fork(fileURLToPath(new URL("./continuity-e2-sizing-child.mjs", import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
  });
  return new Promise((resolve, reject) => {
    let result, failure;
    child.on("error", reject);
    child.on("message", message => {
      if (message?.type === "diagnostic") onDiagnostic?.(message.value);
      else if (message?.type === "result" && message.pid === child.pid) result = message.report;
      else if (message?.type === "failure") {
        const code = knownRefusalCode(message.code) ?? "E2_PROTECTED_SIZING_INVALID";
        failure = Object.assign(Error(code), { code });
        const { errorName, errorCode, site } = diagnosticRecord(message.diagnostic ?? {});
        failures.set(failure, { errorName, errorCode, site });
      }
      else { failure = Error("E2_PROTECTED_SIZING_INVALID"); child.kill(); }
    });
    child.on("close", code => {
      if (code === 0 && result && !failure) resolve(result);
      else reject(failure ?? Error("E2_PROTECTED_SIZING_INVALID"));
    });
    child.send(input, error => { if (error) { failure = error; child.kill(); } });
  });
}
