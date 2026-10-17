import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ events: [] as string[], fail: "", temporaryPaths: [] as string[] }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const event = (name: string): void => {
    fault.events.push(name);
    if (fault.fail === name) throw new Error(`injected ${name}`);
  };
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const directory = args[1] === "r";
      if (args[1] === "wx") fault.temporaryPaths.push(String(args[0]));
      return new Proxy(handle, { get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...callArgs: unknown[]) => {
          if (property === "writeFile") event("write");
          if (property === "sync") event(directory ? "parent-sync" : "file-sync");
          if (property === "close") event(directory ? "parent-close" : "file-close");
          return Reflect.apply(value, target, callArgs);
        };
      } });
    },
    rename: async (...args: Parameters<typeof fs.rename>) => { event("rename"); return await fs.rename(...args); },
    chmod: async (...args: Parameters<typeof fs.chmod>) => { event("chmod"); return await fs.chmod(...args); },
    rm: async (...args: Parameters<typeof fs.rm>) => { event("cleanup"); return await fs.rm(...args); },
  };
});

import { ensureOwnerOnlyDirectory, readBoundedOwnerOnlyFile, readBoundedOwnerOnlyFileWithStats, writeJsonAtomic, writeTextAtomic } from "../durable-state/private-files.js";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), "node_modules/private-files-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  fault.fail = "";
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  fault.events.length = 0;
  fault.temporaryPaths.length = 0;
});

describe("shared private file IO", () => {
  it("keeps exact JSON/text bytes and optional parent-sync ordering", async () => {
    const root = await directory();
    const path = join(root, "record.json");
    fault.events.length = 0;
    await writeJsonAtomic(path, { state: "ready" });
    expect(await readFile(path, "utf8")).toBe('{\n  "state": "ready"\n}\n');
    expect(fault.events).toEqual(["write", "file-sync", "file-close", "rename", ...(process.platform === "win32" ? [] : ["chmod"]), "parent-sync", "parent-close", "cleanup"]);
    fault.events.length = 0;
    await writeJsonAtomic(path, null, false);
    expect(fault.events).not.toContain("parent-sync");
    await writeTextAtomic(path, "exact\n", 6);
    expect(await readFile(path, "utf8")).toBe("exact\n");
    expect(fault.events).toContain("parent-sync");
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses oversized encoded bytes before creating a temporary file", async () => {
    const root = await directory();
    const path = join(root, "record");
    await expect(writeTextAtomic(path, "é", 1)).rejects.toThrow(`Durable continuation file exceeds its 1 byte safety limit: ${path}`);
    await expect(writeJsonAtomic(path, "é", true, 4)).rejects.toThrow("4 byte safety limit");
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["write", "file-sync", "rename", ...(process.platform === "win32" ? [] : ["chmod"]), "parent-sync"])("cleans the exact temporary identity after %s failure", async (failure) => {
    const root = await directory();
    const path = join(root, "record");
    await writeFile(path, "old", { mode: 0o600 });
    fault.fail = failure;
    await expect(writeTextAtomic(path, "new", 3)).rejects.toThrow(`injected ${failure}`);
    fault.fail = "";
    expect(await readdir(root)).toEqual(["record"]);
    expect(await readFile(path, "utf8")).toBe(["chmod", "parent-sync"].includes(failure) ? "new" : "old");
    expect(fault.events).toContain("cleanup");
    const prefix = join(root, `.${createHash("sha256").update(path).digest("hex").slice(0, 12)}-${process.pid}-`);
    expect(fault.temporaryPaths[0]?.startsWith(prefix)).toBe(true);
    expect(fault.temporaryPaths[0]?.slice(prefix.length)).toMatch(/^[a-f0-9-]{36}\.tmp$/u);
  });

  it("keeps owner, link, mode and bounded-reader refusals", async () => {
    const root = await directory();
    const path = join(root, "record");
    await writeFile(path, "safe", { mode: 0o600 });
    expect(await readBoundedOwnerOnlyFileWithStats(path, 4, "State")).toEqual({ text: "safe", bytes: 4 });
    await expect(readBoundedOwnerOnlyFile(path, 3, "State")).rejects.toThrow("3 byte safety limit");
    const alias = join(root, "alias");
    await symlink(path, alias);
    await expect(readBoundedOwnerOnlyFile(alias, 4, "State")).rejects.toThrow("not a regular file");
    await rm(alias);
    await link(path, alias);
    await expect(readBoundedOwnerOnlyFile(path, 4, "State")).rejects.toThrow("exactly one filesystem link");
    await rm(alias);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(readBoundedOwnerOnlyFile(path, 4, "State")).rejects.toThrow("permissions are not owner-only");
      const subdir = join(root, "subdir");
      await mkdir(subdir, { mode: 0o755 });
      await ensureOwnerOnlyDirectory(subdir);
      expect((await lstat(subdir)).mode & 0o777).toBe(0o700);
    }
  });
});
