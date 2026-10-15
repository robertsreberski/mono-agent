import { lstat, open, realpath } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveSubagentObservationGit } from "../subagent-observation-git.js";
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), open: vi.fn(), realpath: vi.fn() }));
const mac = "/Library/Developer/CommandLineTools/usr/bin/git";
let magic: string;
const close = vi.fn(async () => {});
const file = { uid: 0n, mode: 0o100755n, dev: 1n, ino: 2n, size: 100n, mtimeNs: 3n, ctimeNs: 4n, isFile: () => true };
const stat = vi.fn(async () => ({ ...file }));
beforeEach(() => {
  vi.clearAllMocks(); magic = "cafebabe";
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(lstat).mockResolvedValue({ uid: 0, mode: 0o40755, isDirectory: () => true } as never);
  stat.mockReset().mockResolvedValue({ ...file });
  vi.mocked(open).mockResolvedValue({ stat, close, read: async (buffer: Buffer) => {
    Buffer.from(magic, "hex").copy(buffer); return { bytesRead: 4, buffer };
  } } as never);
});
it("selects fixed native Command Line Tools on Darwin without PATH or xcode-select", async () => {
  expect(await resolveSubagentObservationGit("darwin")).toEqual({ path: mac, identity: "1:2:100:3:4" });
  expect(vi.mocked(realpath).mock.calls).toEqual([[mac]]);
  expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual([
    "/Library/Developer/CommandLineTools/usr/bin", "/Library/Developer/CommandLineTools/usr",
    "/Library/Developer/CommandLineTools", "/Library/Developer", "/Library", "/",
  ]);
  expect(close).toHaveBeenCalledOnce();
});
it("selects only the system ELF Git on Linux", async () => {
  magic = "7f454c46";
  expect((await resolveSubagentObservationGit("linux")).path).toBe("/usr/bin/git");
});
it("does not fall back to a shim, PATH wrapper or host execution if tooling is absent", async () => {
  vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
  await expect(resolveSubagentObservationGit("darwin")).rejects.toThrow();
  expect(realpath).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
});
it("rejects a redirected executable before opening it", async () => {
  vi.mocked(realpath).mockResolvedValue("/untrusted/git");
  await expect(resolveSubagentObservationGit("darwin")).rejects.toThrow("observation_unavailable");
  expect(open).not.toHaveBeenCalled();
});
it.each([
  { uid: 501, mode: 0o40755, isDirectory: () => true },
  { uid: 0, mode: 0o40775, isDirectory: () => true },
  { uid: 0, mode: 0o40755, isDirectory: () => false },
])("rejects untrusted executable ancestry %#", async (directory) => {
  vi.mocked(lstat).mockResolvedValueOnce(directory as never);
  await expect(resolveSubagentObservationGit("darwin")).rejects.toThrow("observation_unavailable");
  expect(open).not.toHaveBeenCalled();
});
it.each([
  { uid: 501n }, { mode: 0o100775n }, { mode: 0o100644n }, { isFile: () => false },
])("rejects unsafe executable ownership/mode/type %# and closes its descriptor", async (fields) => {
  stat.mockResolvedValueOnce({ ...file, ...fields });
  await expect(resolveSubagentObservationGit("darwin")).rejects.toThrow("observation_unavailable");
  expect(close).toHaveBeenCalledOnce();
});
it.each(["23212f62", "7f454c46", "00000000"])("rejects non-Mach-O Darwin tooling %s", async (header) => {
  magic = header;
  await expect(resolveSubagentObservationGit("darwin")).rejects.toThrow("observation_unavailable");
  expect(close).toHaveBeenCalledOnce();
});
it("returns a different identity after replacement or content mutation", async () => {
  const before = await resolveSubagentObservationGit("darwin");
  stat.mockResolvedValueOnce({ ...file, ctimeNs: 5n });
  expect((await resolveSubagentObservationGit("darwin")).identity).not.toBe(before.identity);
});
it("fails closed on unsupported platforms without looking for executables", async () => {
  await expect(resolveSubagentObservationGit("win32")).rejects.toThrow("observation_unavailable");
  expect(realpath).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
