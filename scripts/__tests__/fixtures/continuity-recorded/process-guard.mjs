// Test-only containment for real product ownership on macOS. Never imported by
// the importer or inert server. Do not turn this into an executable-tool adapter.
import subprocess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
export function identityProbeAllowed(executable, args, options, stack = "") {
  if (process.platform !== "darwin" || !Array.isArray(args) || !options || options.shell !== undefined
    || options.encoding !== "utf8" || options.windowsHide !== true || options.timeout !== 5000 || options.killSignal !== "SIGKILL"
    || Object.keys(options).some(k => !["encoding", "windowsHide", "env", "timeout", "killSignal"].includes(k))) return false;
  const env = options.env;
  if (!env || env.PATH !== "/usr/bin:/bin" || env.LANG !== "C" || env.LC_ALL !== "C" || (env.TZ !== undefined && env.TZ !== "UTC")
    || Object.keys(env).some(k => !["PATH", "LANG", "LC_ALL", "TZ"].includes(k))) return false;
  if (!/packages\/conversation\/(?:src|dist)\/process-incarnation\.(?:ts|js)/.test(stack)) return false;
  return executable === "/bin/ps" && args.length === 4 && args[0] === "-p" && [String(process.pid), String(process.ppid)].includes(args[1]) && args[2] === "-o" && args[3] === "lstart="
    || executable === "/usr/sbin/sysctl" && args.length === 2 && args[0] === "-n" && ["kern.bootsessionuuid", "kern.boottime"].includes(args[1]);
}
export function installProcessGuard({ hit, refuse }) {
  const originals = new Map(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map(k => [k, subprocess[k]]));
  for (const [name, original] of originals) subprocess[name] = (...args) => {
    if (name === "execFile" && identityProbeAllowed(args[0], args[1], args[2], new Error().stack)) {
      hit(args[0] === "/bin/ps" ? "ps" : "sysctl"); return original(...args);
    }
    refuse(); throw Error("fictional_execution_denied");
  };
  syncBuiltinESMExports();
  return () => { for (const [name, original] of originals) subprocess[name] = original; syncBuiltinESMExports(); };
}
