import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openProcessJobStore, PROCESS_JOB_MANIFEST_FILE, PROCESS_JOB_TRANSACTION_FILE, type DurableProcessJobRecord } from "../process-jobs-store.js";

const unsafeOwner = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const info = await fs.lstat(...args);
    if (String(args[0]) === unsafeOwner.path) info.uid = typeof info.uid === "bigint" ? info.uid + 1n : info.uid + 1;
    return info;
  } };
});

const roots: string[] = [];
afterEach(async () => { unsafeOwner.path = ""; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const phases = ["staging", "claimed", "published", "claim-removed", "complete", "rollback-moved", "rollback-linked", "rollback-restored", "rollback-cleaned", "restore-linked"] as const;
type Phase = typeof phases[number];

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".store-crash-")); roots.push(root);
  const state = join(root, "jobs");
  const store = await openProcessJobStore(root, state);
  const id = randomUUID();
  const record: DurableProcessJobRecord = {
    schemaVersion: 1, generation: randomUUID(), jobId: id, tool: "Exec", state: "queued",
    summary: "previous", agentIncarnation: { schema: "mono-agent.process-incarnation.v1", bootSessionId: "test-boot", processStartId: "test-start" },
    pid: null, pgid: null, sandboxSettingsPath: null, argvSummary: "exec", cwd: root, envKeys: [],
    origin: { conversationId: "web:fictional", baseConversationId: "web:fictional", bucket: null, replyToConversationId: "web:fictional", normalizedReplyTarget: "web:fictional", runId: "test", historyBoundary: "test", channel: "web" },
    chainDepth: 0, maxRuntimeMs: 1000, maxOutputBytes: 1024, previewChars: 100,
    admittedAt: "2026-01-01T00:00:00.000Z", queueDeadlineAt: "2026-01-01T00:01:00.000Z",
    startedAt: null, runtimeDeadlineAt: null, completedAt: null, exitCode: null, signal: null, durationMs: null,
    stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: `artifacts/${id}/stdout.log`, stderrRef: `artifacts/${id}/stderr.log`,
    cancelRequested: false, wake: { state: "pending", attempts: 0, deliveryKey: `process-job:${id}`, lastAttemptAt: null }, lastError: null,
  };
  await store.mutate((draft) => { draft.set(id, record); });
  await store.ensureArtifacts(id);
  return { root, state, store, record, id };
}

// Exact names and filesystem operations from secureFileReplace; no timing or retries.
async function residue(path: string, next: string, phase: Phase, present = true) {
  const temporary = join(dirname(path), `.${basename(path)}.mono-agent-${randomUUID()}.tmp`);
  const stem = join(dirname(path), `.${basename(path)}.${randomUUID()}.mono-agent`);
  const previous = `${stem}-previous`; const failed = `${stem}-failed`;
  if (!present) await rm(path, { force: true });
  await writeFile(temporary, phase === "staging" ? "{" : next, { mode: 0o600 });
  if (phase !== "staging") {
    if (present) await rename(path, previous);
    if (phase !== "claimed" && phase !== "restore-linked") {
      await link(temporary, path);
      if (phase.startsWith("rollback-")) {
        await rename(path, failed);
        if (phase !== "rollback-moved" && present) await link(previous, path);
        if (["rollback-restored", "rollback-cleaned"].includes(phase) && present) await unlink(previous);
        if (phase === "rollback-cleaned") await unlink(temporary);
      } else {
        if (["claim-removed", "complete"].includes(phase) && present) await unlink(previous);
        if (phase === "complete") await unlink(temporary);
      }
    } else if (phase === "restore-linked") await link(previous, path);
  }
  return { temporary, previous, failed };
}

it.each(phases)("reopens record replacement at %s, preserves the committed version and consumes residue", async (phase) => {
  const f = await fixture(); const path = join(f.store.recordsDir, `${f.id}.json`);
  const next = JSON.stringify({ ...f.record, summary: "published" });
  await residue(path, next, phase);
  const committed = ["published", "claim-removed", "complete"].includes(phase) ? "published" : "previous";
  for (let reopen = 0; reopen < 2; reopen++) {
    const store = await openProcessJobStore(f.root, f.state);
    expect((await store.get(f.id))?.summary).toBe(committed);
    expect(await readdir(store.recordsDir)).toEqual([`${f.id}.json`]);
    expect((await lstat(path)).nlink).toBe(1);
  }
});

it.each(phases)("reopens transaction publication at %s before replay", async (phase) => {
  const f = await fixture(); const path = join(f.state, PROCESS_JOB_TRANSACTION_FILE);
  const transaction = (summary: string) => JSON.stringify({ schemaVersion: 1, generation: f.record.generation, createdAt: f.record.admittedAt, write: { ...f.record, summary }, delete: null });
  await writeFile(path, transaction("previous"), { mode: 0o600 });
  await residue(path, transaction("published"), phase);
  const store = await openProcessJobStore(f.root, f.state);
  expect((await store.get(f.id))?.summary).toBe(["published", "claim-removed", "complete"].includes(phase) ? "published" : "previous");
  expect((await readdir(f.state)).filter((name) => name.includes("mono-agent-") || name.includes(".mono-agent-"))).toEqual([]);
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(phases)("recovers manifest and retained output at %s", async (phase) => {
  const f = await fixture();
  const manifest = join(f.state, PROCESS_JOB_MANIFEST_FILE);
  const old = JSON.parse(await readFile(manifest, "utf8"));
  const next = JSON.stringify({ ...old, updatedAt: "2026-01-02T00:00:00.000Z" });
  await residue(manifest, next, phase);
  const output = join(f.store.artifactsDir, f.id, "stdout.log");
  await writeFile(output, "previous", { mode: 0o600 });
  await residue(output, "published", phase);
  await openProcessJobStore(f.root, f.state);
  const published = ["published", "claim-removed", "complete"].includes(phase);
  expect(JSON.parse(await readFile(manifest, "utf8")).updatedAt).toBe(published ? "2026-01-02T00:00:00.000Z" : old.updatedAt);
  expect(await readFile(output, "utf8")).toBe(published ? "published" : "previous");
  expect((await readdir(dirname(output))).sort()).toEqual(["stderr.log", "stdout.log"]);
});

it.each(["staging", "claimed", "published", "claim-removed", "complete", "rollback-moved", "rollback-restored", "rollback-cleaned"] as const)("recovers first transaction publication at %s", async (phase) => {
  const f = await fixture(); const path = join(f.state, PROCESS_JOB_TRANSACTION_FILE);
  const next = JSON.stringify({ schemaVersion: 1, generation: f.record.generation, createdAt: f.record.admittedAt, write: { ...f.record, summary: "published" }, delete: null });
  await residue(path, next, phase, false);
  const store = await openProcessJobStore(f.root, f.state);
  expect((await store.get(f.id))?.summary).toBe(["published", "claim-removed", "complete"].includes(phase) ? "published" : "previous");
  expect((await readdir(f.state)).filter((name) => name.includes(".mono-agent") || name.endsWith(".tmp"))).toEqual([]);
});

it.each(["unknown", "symlink", "mode", "owner", "external-link", "unpaired-target", "unrelated-pair", "extra-claim", "mismatched-claims"])("refuses unsafe recovery residue: %s", async (kind) => {
  const f = await fixture(); const path = join(f.store.recordsDir, `${f.id}.json`);
  const paths = await residue(path, JSON.stringify({ ...f.record, summary: "published" }), "published");
  if (kind === "unknown") await writeFile(join(f.store.recordsDir, ".foreign.tmp"), "foreign", { mode: 0o600 });
  if (kind === "symlink") { await unlink(paths.previous); await symlink(path, paths.previous); }
  if (kind === "owner") unsafeOwner.path = paths.previous;
  if (kind === "mode") await chmod(paths.previous, 0o644);
  if (kind === "external-link") await link(path, join(f.root, "foreign-link"));
  if (kind === "unpaired-target") await rename(paths.temporary, join(f.root, "foreign-link"));
  if (kind === "unrelated-pair") { await unlink(paths.temporary); await writeFile(paths.temporary, "foreign", { mode: 0o600 }); await link(path, join(f.root, "foreign-link")); }
  if (kind === "extra-claim") await writeFile(join(f.store.recordsDir, `.${basename(path)}.${randomUUID()}.mono-agent-previous`), "foreign", { mode: 0o600 });
  if (kind === "mismatched-claims") {
    await rename(path, paths.failed);
    await rename(paths.previous, join(f.store.recordsDir, `.${basename(path)}.${randomUUID()}.mono-agent-previous`));
  }
  const before = await readdir(f.store.recordsDir);
  await expect(openProcessJobStore(f.root, f.state)).rejects.toThrow();
  expect(await readdir(f.store.recordsDir)).toEqual(before);
  expect(await readFile(kind === "mismatched-claims" ? paths.failed : path, "utf8")).toContain("published");
});

it.each(phases)("recovers other store-owned root files at %s", async (phase) => {
  const f = await fixture();
  const names = ["process-jobs-secret", "process-jobs-health-v1.json", "PROCESS-JOBS-STORE-V1"];
  const expected = new Map<string, string>();
  for (const name of names) {
    const path = join(f.state, name);
    const old = name === "PROCESS-JOBS-STORE-V1" ? await readFile(path, "utf8") : "previous";
    await writeFile(path, old, { mode: 0o600 });
    const next = name === "PROCESS-JOBS-STORE-V1" ? old : "published";
    await residue(path, next, phase);
    expected.set(path, ["published", "claim-removed", "complete"].includes(phase) ? next : old);
  }
  await openProcessJobStore(f.root, f.state);
  for (const [path, contents] of expected) {
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await lstat(path)).nlink).toBe(1);
  }
  expect((await readdir(f.state)).filter((name) => name.includes(".mono-agent") || name.endsWith(".tmp"))).toEqual([]);
});

it.each(["staging", "claimed", "published", "claim-removed", "complete", "rollback-moved", "rollback-cleaned"] as const)("recovers interrupted store initialization at %s", async (phase) => {
  const f = await fixture();
  const guard = join(f.state, "PROCESS-JOBS-STORE-V1");
  const manifest = join(f.state, PROCESS_JOB_MANIFEST_FILE);
  await residue(guard, await readFile(guard, "utf8"), phase, false);
  await residue(manifest, await readFile(manifest, "utf8"), phase, false);
  expect((await openProcessJobStore(f.root, f.state)).health.state).toBe("ok");
  expect((await readdir(f.state)).filter((name) => name.includes(".mono-agent") || name.endsWith(".tmp"))).toEqual([]);
});

it.each(["root", "output"])("refuses unknown replacement names in the %s directory", async (directory) => {
  const f = await fixture();
  const path = join(directory === "root" ? f.state : join(f.store.artifactsDir, f.id), ".foreign.tmp");
  await writeFile(path, "foreign", { mode: 0o600 });
  await expect(openProcessJobStore(f.root, f.state)).rejects.toThrow(/unsupported/u);
  expect(await readFile(path, "utf8")).toBe("foreign");
});
