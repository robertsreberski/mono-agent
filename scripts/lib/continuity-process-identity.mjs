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

/** Content-free process membership; preserve the same UTC/C identity used by the lease. */
export function lookupProcessGroupSnapshot(pgid) {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid=,lstart=,stat="], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim().split("\n").flatMap(line => {
    const parts = line.trim().split(/\s+/u), pid = Number(parts[0]), group = Number(parts[1]);
    return group === pgid && parts.length === 8 ? [{ pid, pgid: group, startIdentity: parts.slice(2, 7).join(" "), zombie: parts[7].startsWith("Z") }] : [];
  });
}
