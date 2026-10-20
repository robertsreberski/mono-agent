import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // The file itself is already fsynced; some platforms/filesystems reject directory fsync.
  } finally {
    await handle?.close();
  }
}
