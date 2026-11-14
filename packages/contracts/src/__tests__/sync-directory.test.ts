import { afterEach, expect, it, vi } from "vitest";
import { open } from "node:fs/promises";
import { syncDirectory } from "../sync-directory.js";
vi.mock("node:fs/promises", () => ({ open: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
for (const platform of ["win32", "linux"]) for (const phase of ["open", "sync"]) it.each(["EISDIR", "EPERM", "EACCES", "EINVAL", "EBADF", "EIO"])(`handles %s during ${phase} on ${platform} without masking real I/O errors`, async (code) => {
  vi.stubGlobal("process", new Proxy(process, { get: (target, property) => property === "platform" ? platform : Reflect.get(target, property) }));
  const error = Object.assign(new Error("Fictional directory sync failure"), { code });
  const close = vi.fn(async () => undefined);
  if (phase === "open") vi.mocked(open).mockRejectedValue(error);
  else vi.mocked(open).mockResolvedValue({ sync: vi.fn().mockRejectedValue(error), close } as unknown as Awaited<ReturnType<typeof open>>);
  const work = syncDirectory("fictional-directory");
  if (platform === "win32" && code !== "EIO") await expect(work).resolves.toBeUndefined();
  else await expect(work).rejects.toBe(error);
  expect(close).toHaveBeenCalledTimes(phase === "sync" ? 1 : 0);
});
