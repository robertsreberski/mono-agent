import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasRetiredPiSessionsRoot, MonoAgentConfigError } from "@mono-agent/config";
import { probeUnsupportedSessionsRoot } from "@mono-agent/turn/engine/sessions.js";
import { assertNoOldSessionsRoot, assertSupportedSessionsRoot } from "../conversation-admin/sessions-root.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("read-only session root facts", () => {
  it("preserves raw callers' guards, own presence and error details", () => {
    for (const native of [undefined, null, false, "old", {}, Object.create({ piSessionsRoot: "inherited" })]) {
      expect(hasRetiredPiSessionsRoot(native)).toBe(false);
      expect(() => assertNoOldSessionsRoot({ providers: { piNative: native } })).not.toThrow();
    }
    for (const native of [{ piSessionsRoot: undefined }, { piSessionsRoot: null }, Object.assign([], { piSessionsRoot: "" })]) {
      expect(hasRetiredPiSessionsRoot(native)).toBe(true);
      try { assertNoOldSessionsRoot({ providers: { piNative: native }, runtime: { session: { root: "new" } } }); }
      catch (error) {
        expect(error).toBeInstanceOf(MonoAgentConfigError);
        expect(error).toMatchObject({ code: "invalid_json", details: { path: "providers.piNative.piSessionsRoot" },
          message: "providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there" });
        expect((error as MonoAgentConfigError).details).not.toHaveProperty("paths");
        continue;
      }
      throw new Error("Expected retired-field refusal");
    }
  });

  it.each(["directory", "file", "symlink"])("refuses a present %s without modifying state", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "root-preflight-")); roots.push(root);
    const path = join(root, "mono-v2");
    await expect(assertSupportedSessionsRoot(undefined)).resolves.toBeUndefined();
    expect(await probeUnsupportedSessionsRoot(root)).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
    if (kind === "directory") { await mkdir(path); await writeFile(join(path, "evidence"), "fictional evidence"); }
    else if (kind === "file") await writeFile(path, "fictional evidence");
    else await symlink("absent-target", path);
    await chmod(root, 0o700);
    const before = await lstat(root);
    expect(await probeUnsupportedSessionsRoot(root)).toBe(path);
    const result = assertSupportedSessionsRoot(root);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toMatchObject({ code: "invalid_json", details: { path: "runtime.session.root" },
      message: `Sessions root contains ${path}, written by a pre-release build; restore a backup or remove it after checking nothing in it is needed. No automatic migration is supported.` });
    expect(await readdir(root)).toEqual(["mono-v2"]);
    expect((await lstat(root)).mode).toBe(before.mode);
    if (kind !== "symlink") expect(await readFile(kind === "file" ? path : join(path, "evidence"), "utf8")).toBe("fictional evidence");
  });

  it("propagates non-ENOENT errors instead of treating them as absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "root-errors-")); roots.push(root);
    const file = join(root, "not-directory"); await writeFile(file, "fixture");
    await expect(probeUnsupportedSessionsRoot(file)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(assertSupportedSessionsRoot(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
