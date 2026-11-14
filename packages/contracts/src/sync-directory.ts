import { open } from "node:fs/promises";

/** Sync directory metadata; tolerate only documented Windows unsupported errors. */
export async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (process.platform === "win32"
      && error !== null && typeof error === "object" && !Array.isArray(error) && "code" in error
      && (error.code === "EISDIR"
        || error.code === "EPERM"
        || error.code === "EACCES"
        || error.code === "EINVAL"
        || error.code === "EBADF")) {
      return;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}
