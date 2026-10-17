import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const stats = vi.hoisted(() => ({ override: undefined as object | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => stats.override ?? actual.lstat(...args)) };
});

import { assertManagedSrtDirectory, assertManagedSrtRegularFile, hashPrivateManagedSrtTree } from "../sandbox/managed-verifier.js";

const roots: string[] = [];
afterEach(async () => {
  stats.override = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "srt-inspection-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("managed SRT read-only profiles", () => {
  it("preserves the foreign-owner marker policy difference", async () => {
    stats.override = { uid: (process.getuid?.() ?? 0) + 10, mode: 0o600, nlink: 1,
      isSymbolicLink: () => false, isFile: () => true };
    await expect(assertManagedSrtRegularFile("/fictional/marker", { requirePrivate: true, policy: "installer" })).resolves.toBeUndefined();
    if (process.getuid !== undefined) {
      await expect(assertManagedSrtRegularFile("/fictional/marker", { requirePrivate: true, label: "managed marker", installRoot: "/fictional/root" }))
        .rejects.toMatchObject({ name: "ManagedSrtCorruptError", installRoot: "/fictional/root",
          message: "Managed SRT install at /fictional/root is unsafe or corrupt: managed marker has an unexpected owner" });
    }
  });

  it.each(["file", "directory"])("rejects foreign-owned tree %s entries under both profiles", async (kind) => {
    const root = await fixture();
    const path = join(root, "entry");
    if (kind === "directory") await mkdir(path, { mode: 0o700 });
    else await writeFile(path, "fixture", { mode: 0o600 });
    stats.override = { uid: (process.getuid?.() ?? 0) + 10, mode: 0o700, nlink: 1,
      isSymbolicLink: () => false, isDirectory: () => kind === "directory", isFile: () => kind === "file" };
    await expect(hashPrivateManagedSrtTree(root, "runtime")).rejects.toMatchObject({
      message: `Managed SRT install at ${root} is unsafe or corrupt: managed dependency tree has an unexpected owner: entry`,
    });
    await expect(hashPrivateManagedSrtTree(root, "installer")).rejects.toMatchObject({
      message: "unsafe managed dependency tree entry: entry",
    });
  });

  it("rejects foreign-owned directories under both profiles with exact wording", async () => {
    stats.override = { uid: (process.getuid?.() ?? 0) + 10, mode: 0o700,
      isSymbolicLink: () => false, isDirectory: () => true };
    await expect(assertManagedSrtDirectory("/fictional/directory", "install root", "/fictional/root", "runtime"))
      .rejects.toMatchObject({ message: "Managed SRT install at /fictional/root is unsafe or corrupt: install root is not owned by the current user" });
    await expect(assertManagedSrtDirectory("/fictional/directory", "", "/fictional/root", "installer"))
      .rejects.toMatchObject({ message: "/fictional/directory must be a real owner-only directory owned by the current user" });
  });

  it("accepts a root-owned managed file for a non-root runtime caller", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(1234);
    stats.override = { uid: 0, mode: 0o600, nlink: 1, isSymbolicLink: () => false, isFile: () => true };
    await expect(assertManagedSrtRegularFile("/fictional/marker", { requirePrivate: true, label: "managed marker", installRoot: "/fictional/root" }))
      .resolves.toBeUndefined();
  });

  it("retains caller-specific directory and regular-file messages", async () => {
    const root = await fixture();
    const file = join(root, "marker");
    await writeFile(file, "fixture", { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(assertManagedSrtRegularFile(file, { requirePrivate: true, policy: "installer" }))
      .rejects.toThrow(`${file} must be a private single-link regular file`);
    await expect(assertManagedSrtRegularFile(file, { requirePrivate: true, label: "managed marker", installRoot: root }))
      .rejects.toThrow("managed marker grants access to group or other users");
    await chmod(root, 0o755);
    await expect(assertManagedSrtDirectory(root, "", root, "installer"))
      .rejects.toThrow(`${root} must be a real owner-only directory owned by the current user`);
    await expect(assertManagedSrtDirectory(root, "install root", root))
      .rejects.toThrow("install root grants access to group or other users");
  });

  it("pins traversal, framing and exclusions independently without writing", async () => {
    const root = await fixture();
    await mkdir(join(root, "z"), { mode: 0o700 });
    await mkdir(join(root, "node_modules"), { mode: 0o700 });
    await writeFile(join(root, "z", "b"), "second", { mode: 0o600 });
    await writeFile(join(root, "a"), "first", { mode: 0o600 });
    await writeFile(join(root, ".mono-agent-srt.json"), "not hashed");
    await writeFile(join(root, "node_modules", ".package-lock.json"), "not hashed");
    const expected = createHash("sha256").update("F\0a\0" + "5\0firstD\0node_modules\0D\0z\0F\0z/b\0" + "6\0second").digest("hex");
    const before = await readdir(root);
    for (const policy of ["runtime", "installer"] as const) {
      expect(await hashPrivateManagedSrtTree(root, policy)).toBe(expected);
    }
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(join(root, "a"), "utf8")).toBe("first");
  });

  it.each(["symlink", "hardlink", "mode"])("rejects %s trees with each wrapper's wording", async (kind) => {
    const root = await fixture();
    const file = join(root, "entry");
    if (kind === "symlink") await symlink("absent", file);
    else {
      await writeFile(file, "fixture", { mode: 0o600 });
      if (kind === "hardlink") await link(file, join(root, "alias"));
      else await chmod(file, 0o644);
    }
    await expect(hashPrivateManagedSrtTree(root, "installer")).rejects.toThrow(kind === "hardlink"
      ? "unsupported managed dependency tree entry: alias" : "unsafe managed dependency tree entry: entry");
    await expect(hashPrivateManagedSrtTree(root)).rejects.toMatchObject({ name: "ManagedSrtCorruptError", installRoot: root });
  });
});
