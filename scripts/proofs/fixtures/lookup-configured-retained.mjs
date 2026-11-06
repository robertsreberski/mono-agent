import fs from "node:fs";
import { join } from "node:path";

// Synchronous probe observer; kept separate so parity can be tested without preload side effects.
export function retainedSync(slotRoot) {
  const sizes = {snapshotBytes: 0, workBytes: 0, homeBytes: 0, otherBytes: 0};
  const walk = (path, relative = "") => {
    const stat = fs.lstatSync(path), bytes = Math.max(stat.size, stat.blocks * 512);
    const field = relative === "checkpoint/snapshot" || relative.startsWith("checkpoint/snapshot/") ? "snapshotBytes"
      : relative === "checkpoint/work" || relative.startsWith("checkpoint/work/") ? "workBytes"
      : relative === "checkpoint/lease-home" || relative.startsWith("checkpoint/lease-home/") || relative && !relative.startsWith("checkpoint") ? "homeBytes" : "otherBytes";
    sizes[field] += bytes;
    if (stat.isDirectory()) for (const name of fs.readdirSync(path)) walk(join(path, name), relative ? `${relative}/${name}` : name);
  };
  walk(slotRoot); return {...sizes, retainedBytes: Object.values(sizes).reduce((a, b) => a + b, 0)};
}
