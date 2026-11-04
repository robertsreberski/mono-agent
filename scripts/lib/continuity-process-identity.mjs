import { execFileSync } from "node:child_process";

/** Stable lookup identity; legacy persisted local-time identities are intentionally unchanged. */
export function lookupProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}
