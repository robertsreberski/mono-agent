import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
export const OFFLINE_FLAGS = ["--config.verify-deps-before-run=false", "--config.manage-package-manager-versions=false", "--config.offline=true"];
// Add execution flags only. Run every genuine production build/verification;
// never replace results, source, runtime entrypoints or module resolution.
export async function withOfflineBuilds(fn, commands = []) {
  const original = child.execFileSync;
  child.execFileSync = function (file, args, options) {
    if (file === "pnpm") {args = [...OFFLINE_FLAGS, ...args]; commands.push({file, args});}
    return original.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  try {return await fn();} finally {child.execFileSync = original; syncBuiltinESMExports();}
}
