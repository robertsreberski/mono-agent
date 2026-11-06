import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, lstat, chmod, symlink, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupRegistryReadiness } from "../lib/continuity-lookup-registry-readiness.mjs";

const dirs = [];
async function fixture() {const dir = await mkdtemp(join(realpathSync(tmpdir()), "lookup-registry-check-")); dirs.push(dir); return dir;}
afterEach(async () => {vi.restoreAllMocks(); vi.doUnmock("node:os"); vi.resetModules(); for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true});});
it("checks a missing registry parent without creating it or changing its nearest ancestor", async () => {
  const home = await fixture(), before = await lstat(home, {bigint: true});
  expect(await lookupRegistryReadiness(home)).toEqual({ready: true, parentExists: false, checked: 0, missing: 5, code: "lookup_registry_parent_will_be_created"});
  const after = await lstat(home, {bigint: true}); expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
  expect(await readdir(home)).toEqual([]);
});
it.each([0o700, 0o755, 0o722])("checks existing registry parent permissions read-only (mode=%s)", async mode => {
  const home = await fixture(), parent = join(home, ".local/state/mono-agent/lookup-pilot/consumed-v1"); await mkdir(parent, {recursive: true, mode: 0o700}); await chmod(parent, mode);
  const before = await lstat(parent, {bigint: true}), report = await lookupRegistryReadiness(home), after = await lstat(parent, {bigint: true});
  expect(report.ready).toBe(mode === 0o700); expect([after.ino, after.mtimeNs, after.ctimeNs, after.mode]).toEqual([before.ino, before.mtimeNs, before.ctimeNs, before.mode]);
});
it("refuses aliases and foreign-owned ancestors without creating registry files", async () => {
  const home = await fixture(); await symlink(home, join(home, "alias")); expect((await lookupRegistryReadiness(join(home, "alias"))).ready).toBe(false);
  vi.doMock("node:os", async original => ({...await original(), userInfo: () => ({uid: -2, homedir: home})}));
  const module = await import("../lib/continuity-lookup-registry-readiness.mjs?foreign");
  expect((await module.lookupRegistryReadiness(home)).ready).toBe(false);
});
it("the no-flags CLI checks the OS-home stand-in and rejects a redirect flag", async () => {
  vi.resetModules();
  const home = await fixture(); await mkdir(join(home, ".local/state/mono-agent/lookup-pilot/consumed-v1"), {recursive: true, mode: 0o700});
  vi.doMock("node:os", async original => {const actual = await original(); return {...actual, userInfo: () => ({...actual.userInfo(), homedir: home})};});
  const {main} = await import("../continuity-lookup-compare.mjs"), stdout = vi.fn();
  expect(await main(["registry-preflight"], {stdout})).toBe(0); expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ready: true, parentExists: true, checked: 5});
  await expect(main(["registry-preflight", "--home", home], {stdout})).rejects.toMatchObject({code: "lookup_invalid_arguments"});
});

it("refuses a consumed-directory alias", async () => {
  const home = await fixture(), parent = join(home, ".local/state/mono-agent/lookup-pilot");
  await mkdir(parent, {recursive: true, mode: 0o700}); await symlink(home, join(parent, "consumed-v1"));
  expect((await lookupRegistryReadiness(home)).ready).toBe(false);
});
