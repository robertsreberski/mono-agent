import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// Every linked package leaf, recursively; never follow a symlink. Nanosecond
// ctime detects writes even if bytes/size/mtime are subsequently restored.
export async function dependencyLeafSnapshot(leaves) {
  const pending = [...new Set(leaves)].sort(), rows = []; let cursor = 0;
  await Promise.all(Array.from({length: Math.min(32, pending.length)}, async () => {
    while (cursor < pending.length) {
      const path = pending[cursor++], stat = await lstat(path, {bigint: true});
      const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
      rows.push([path, type, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
      if (type === "directory") for (const name of await readdir(path)) pending.push(join(path, name));
    }
  }));
  return rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
