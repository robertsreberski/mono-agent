// Qualifying sizing is always delegated, never inferred from mutable argv/env.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
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
      else if (message?.type === "failure") failure = Object.assign(Error(message.code ?? "E2_REFUSED"), { code: message.code });
      else { failure = Error("E2_PROTECTED_SIZING_INVALID"); child.kill(); }
    });
    child.on("close", code => {
      if (code === 0 && result && !failure) resolve(result);
      else reject(failure ?? Error("E2_PROTECTED_SIZING_INVALID"));
    });
    child.send(input, error => { if (error) { failure = error; child.kill(); } });
  });
}
