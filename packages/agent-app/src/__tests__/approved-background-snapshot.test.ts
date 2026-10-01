import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedBackgroundSnapshotPath, invalidateApprovedBackgroundSnapshots,
  resolveApprovedBackgroundSnapshot, stageApprovedBackgroundSnapshot,
  type ApprovedBackgroundSnapshotBinding,
} from "../approved-background-snapshot.js";
import { captureBackgroundSnapshot, encodeBackgroundSnapshot, materializeBackgroundRuntimeInputs } from "../background-snapshot.js";

let dir: string;
let binding: ApprovedBackgroundSnapshotBinding;
const proofKey = Buffer.alloc(32, 7);
const env = { PATH: "/usr/bin:/bin" };
async function capture() {
  return captureBackgroundSnapshot({ cwd: dir, configPath: binding.configPath, env, proofKey });
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "approved-startup-"));
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" } }));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\nMorgan helps.\n");
  binding = { configPath, managedRoot: join(dir, "managed"), label: "com.mono-agent.example-12345678", encodedSnapshot: "", launchProof: "runtime-proof" };
  binding = { ...binding, encodedSnapshot: encodeBackgroundSnapshot(await capture()) };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("loads edited bytes on replacement with the ORIGINAL cached argv, and refuses later edits", async () => {
  const cachedArgv = binding.encodedSnapshot;
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(cachedArgv);
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\nMorgan now reviews.\n");
  const candidate = await capture();
  const prepared = await stageApprovedBackgroundSnapshot(binding, candidate);
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(cachedArgv);
  prepared.publish();
  await prepared.dispose();
  expect(binding.encodedSnapshot).toBe(cachedArgv);
  const effective = resolveApprovedBackgroundSnapshot(binding);
  expect(effective).toEqual(candidate);
  const replacement = await materializeBackgroundRuntimeInputs({ snapshot: effective, cwd: dir, env, proofKey, runtimeRoot: join(dir, "inputs") });
  try { expect(await readFile(replacement.privateRuntimePaths.identityPath, "utf8")).toContain("now reviews"); }
  finally { await replacement.dispose(); }
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\nNot approved.\n");
  await expect(materializeBackgroundRuntimeInputs({ snapshot: effective, cwd: dir, env, proofKey, runtimeRoot: join(dir, "inputs") })).rejects.toThrow("approved snapshot changed");
});

it("clears approval even when terminal replacement reuses identical runtime and argv", async () => {
  const candidate = { ...await capture(), identityFingerprint: "new-proof" };
  const prepared = await stageApprovedBackgroundSnapshot(binding, candidate);
  prepared.publish(); await prepared.dispose();
  expect(resolveApprovedBackgroundSnapshot(binding)).toEqual(candidate);
  await invalidateApprovedBackgroundSnapshots(binding);
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(binding.encodedSnapshot);
  // Revisiting the same runtime/snapshot identity cannot resurrect the removed approval.
  expect(resolveApprovedBackgroundSnapshot({ ...binding, launchProof: "other-runtime" })).not.toEqual(candidate);
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(binding.encodedSnapshot);
});

it("binds records to config, runtime and original generation", async () => {
  const prepared = await stageApprovedBackgroundSnapshot(binding, await capture());
  prepared.publish(); await prepared.dispose();
  const destination = approvedBackgroundSnapshotPath({ ...binding, launchProof: "other-runtime" });
  await writeFile(destination, await readFile(approvedBackgroundSnapshotPath(binding)), { mode: 0o600 });
  expect(() => resolveApprovedBackgroundSnapshot({ ...binding, launchProof: "other-runtime" })).toThrow("different binding");
  await expect(stageApprovedBackgroundSnapshot(binding, { ...await capture(), dotenvPath: join(dir, "other.env") })).rejects.toThrow("paths do not match");
});

it.each(["malformed", "public-file", "public-directory", "symlink"])("refuses %s state instead of silently using argv", async (kind) => {
  const prepared = await stageApprovedBackgroundSnapshot(binding, await capture());
  prepared.publish(); await prepared.dispose();
  const path = approvedBackgroundSnapshotPath(binding);
  if (kind === "malformed") await writeFile(path, "{broken");
  if (kind === "public-file") await chmod(path, 0o644);
  if (kind === "public-directory") await chmod(join(binding.managedRoot, "approved-startup"), 0o755);
  if (kind === "symlink") { await rm(path); await symlink(binding.configPath, path); }
  expect(() => resolveApprovedBackgroundSnapshot(binding)).toThrow();
});

it("disposes abandoned preparation without publication", async () => {
  const prepared = await stageApprovedBackgroundSnapshot(binding, await capture());
  await prepared.dispose(); await prepared.dispose();
  expect(await readdir(join(binding.managedRoot, "approved-startup", binding.label))).toEqual([]);
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(binding.encodedSnapshot);
});

it.each([false, true])("restores previous approval after post-rename failure (previous=%s)", async (hasPrevious) => {
  const original = await capture();
  if (hasPrevious) { const old = await stageApprovedBackgroundSnapshot(binding, original); old.publish(); await old.dispose(); }
  const prepared = await stageApprovedBackgroundSnapshot(binding, { ...original, identityFingerprint: "new-proof" }, { afterRename: () => { throw new Error("sync failed"); } });
  expect(() => prepared.publish()).toThrow("publication failed");
  expect(resolveApprovedBackgroundSnapshot(binding)).toEqual(original);
  await prepared.dispose();
});

it("reports failed restoration explicitly and leaves only a complete validated candidate", async () => {
  const candidate = { ...await capture(), identityFingerprint: "new-proof" };
  const fail = () => { throw new Error("injected storage failure"); };
  const prepared = await stageApprovedBackgroundSnapshot(binding, candidate, { afterRename: fail, beforeRestore: fail });
  expect(() => prepared.publish()).toThrow("validated approval may be active");
  expect(resolveApprovedBackgroundSnapshot(binding)).toEqual(candidate);
  await prepared.dispose();
});

it("refuses changed staging before the atomic rename", async () => {
  const prepared = await stageApprovedBackgroundSnapshot(binding, await capture());
  const directory = join(binding.managedRoot, "approved-startup", binding.label);
  const [file] = await readdir(directory);
  await writeFile(join(directory, file!), "{broken");
  expect(() => prepared.publish()).toThrow("publication failed");
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(binding.encodedSnapshot);
  await prepared.dispose();
});

it("rejects a directory link without writing through it", async () => {
  await mkdir(binding.managedRoot, { mode: 0o700 });
  await mkdir(join(dir, "outside"), { mode: 0o700 });
  await symlink(join(dir, "outside"), join(binding.managedRoot, "approved-startup"));
  await expect(stageApprovedBackgroundSnapshot(binding, await capture())).rejects.toThrow("owner-private");
  expect(await readdir(join(dir, "outside"))).toEqual([]);
});

it("updates repeated console approvals without changing the anchor or revisiting old records", async () => {
  for (const text of ["First approved edit", "Second approved edit"]) {
    await writeFile(join(dir, "IDENTITY.md"), `# Identity\n${text}\n`);
    const current = await capture();
    const prepared = await stageApprovedBackgroundSnapshot(binding, current);
    prepared.publish(); await prepared.dispose();
    expect(resolveApprovedBackgroundSnapshot(binding)).toEqual(current);
  }
  expect((await readdir(join(binding.managedRoot, "approved-startup", binding.label))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
});

it.each(["public-mode", "symlink", "file", "unreadable"])("quarantines or repairs %s approval state during lifecycle invalidation", async (corruption) => {
  const prepared = await stageApprovedBackgroundSnapshot(binding, await capture());
  prepared.publish(); await prepared.dispose();
  const store = join(binding.managedRoot, "approved-startup");
  const outside = join(dir, "untouched");
  if (corruption === "public-mode") await chmod(store, 0o755);
  else if (corruption === "unreadable") await chmod(store, 0o000);
  else {
    await rm(store, { recursive: true });
    if (corruption === "file") await writeFile(store, "invalid store", { mode: 0o600 });
    else { await mkdir(outside, { mode: 0o700 }); await writeFile(join(outside, "keep"), "untouched"); await symlink(outside, store); }
  }
  expect(() => resolveApprovedBackgroundSnapshot(binding)).toThrow();
  await invalidateApprovedBackgroundSnapshots(binding);
  expect(encodeBackgroundSnapshot(resolveApprovedBackgroundSnapshot(binding))).toBe(binding.encodedSnapshot);
  if (corruption === "symlink") expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched");
  if (corruption === "unreadable") {
    for (const name of await readdir(binding.managedRoot)) {
      if (name.startsWith("approved-startup.quarantined-")) await chmod(join(binding.managedRoot, name), 0o700);
    }
  }
});
