import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

/** Host-selected native tooling, not a repository read grant or a PATH lookup. */
export async function resolveSubagentObservationGit(platform: NodeJS.Platform = process.platform): Promise<{ path: string; identity: string }> {
  // /usr/bin/git on Darwin is an xcode-select shim which may write external
  // caches and launch xcodebuild. Never run that shim in the read-only lane.
  const path = platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/git"
    : platform === "linux" ? "/usr/bin/git" : undefined;
  if (!path || await realpath(path) !== path) throw new Error("observation_unavailable");
  // Follow the sandbox executable precedent: canonical regular executable and
  // secure ancestry. Here only root-installed system tools are admissible.
  for (let parent = dirname(path);;) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("observation_unavailable");
    if (parent === "/") break;
    parent = dirname(parent);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || (stat.mode & 0o111n) === 0n) throw new Error("observation_unavailable");
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    const magic = header.toString("hex");
    const native = platform === "linux" ? magic === "7f454c46"
      : ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
    if (bytesRead !== 4 || !native) throw new Error("observation_unavailable");
    return { path, identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") };
  } finally { await handle.close(); }
}
