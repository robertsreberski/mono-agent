import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PrivateError, privateCode, validatePrivateRoots, validateTurns, validateRegistration, validateAnnotations, reconstructClone, requirePrivateAncestor, createPrivateOutput, validatePrivateAclMetadata } from "../lib/memory-e2e-private-input.mjs";
import { blindSheets, metrics, newReviewSeed, reviewId, pairedBootstrap, serializePrivateArtifact, summarizePrivate } from "../lib/memory-e2e-private-report.mjs";
import { privateMain, resolvePrivateArm } from "../lib/memory-e2e-private-runner.mjs";
import { assertPrivateRuntimeOptions, validatePrivateRoute, assertPrivateProviderEnvironment, PRIVATE_LOGGING_ENV, privateCompletionRuntime } from "../lib/memory-e2e-private-providers.mjs";
import { invokedMemoryObservation, productionModules } from "../lib/memory-e2e-runner.mjs";
import { parseArguments } from "../memory-e2e-benchmark.mjs";
import * as graph from "../../packages/memory/dist/bujo/graph.js";
import * as grammar from "../../packages/memory/dist/bujo/grammar.js";
import { encodeMemoryLabel } from "../../packages/memory/dist/bujo/labels.js";

// Fictional-only tests: never discover a consumer, config, transcript or store.
const root = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [], aclPaths = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const path of aclPaths.splice(0)) {
    const cleared = spawnSync("/bin/chmod", ["-N", path], { cwd: root, stdio: "ignore", timeout: 5000 });
    if (cleared.status !== 0) throw new Error("private_acl_test_cleanup_failed");
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function setFictionalAcl(path, entry, context) {
  const changed = spawnSync("/bin/chmod", ["+a", entry, path], { cwd: root, stdio: "ignore", timeout: 5000 });
  if (changed.status !== 0) context.skip(true, "private_acl_test_unavailable");
  aclPaths.push(path);
}
const opaque = (n) => n.toString(16).padStart(32, "0");
const sentinel = "FICTIONAL_PRIVATE_SENTINEL pottery wheel";
const registration = () => ({ version: 1, definitions: { useful: "Helps the turn", partial: "Incomplete help", noise: "Not useful", stale: "No longer current" },
  caseSelection: "all_ordered_owner_turns", denominators: "all_selected_turns_and_all_invoked_lines",
  minimumTurns: 400, minimumFollowUps: 50, minimumJudgedFollowUpLines: 100,
  lengthAbstentionMaxCodePoints: 16, snapshot: "approximate_as_of", isolation: { noContentLogs: true, noTelemetry: true, localServiceNoOutbound: true }, productionRoutes: [] });
const turns = () => [
  { id: opaque(1), conversationId: opaque(100), timestamp: "2030-01-01T12:00:00.000Z", ownerText: "Which wheel did Morgan choose for pottery?", assistantText: sentinel, followUp: false, directQuestion: true,
    baselineSource: "provider_session_transcript", baselineLines: [{ kind: "similarity", text: sentinel }] },
  { id: opaque(2), conversationId: opaque(100), timestamp: "2030-01-01T12:01:00.000Z", ownerText: "And Avery?", assistantText: "Acknowledged.", followUp: true, directQuestion: false },
  { id: opaque(3), conversationId: opaque(101), timestamp: "2030-01-01T12:02:00.000Z", ownerText: "Which pottery wheel is available?", followUp: false, directQuestion: true },
];
async function fixture() {
  await mkdir(join(root, ".worklab-tmp"), { recursive: true });
  const dir = await mkdtemp(join(root, ".worklab-tmp", "fictional-private-test-")); dirs.push(dir);
  const inputRoot = join(dir, "input"), storeRoot = join(dir, "source"), outputRoot = join(dir, "output");
  await mkdir(inputRoot, { mode: 0o700 }); await mkdir(join(storeRoot, "daily"), { recursive: true, mode: 0o700 });
  const repository = join(dir, "repository"); await mkdir(repository, { mode: 0o700 });
  return { dir, inputRoot, storeRoot, outputRoot, repositories: [repository], env: {} };
}
const bullet = (id, createdAt, status = "open") => ({ id, type: "note", status, text: sentinel, salience: 0.9, isInsight: false, createdAt, refs: [] });
const row = (n, arm, label = "useful") => ({ dayId: opaque(900000), id: opaque(n + 1), conversationId: opaque(10000 + Math.floor(n / 10)), arm, followUp: n < 50, directQuestion: n >= 50,
  contaminated: false, flags: [], status: "completed", bytes: 30, repeatedBytes: n % 2 ? 30 : 0, latencyMs: 1, chatCalls: 0, embeddingRequests: 1, indexingEmbeddingRequests: 1,
  lines: [0, 1].map((i) => ({ id: opaque(100000 + n * 2 + i), kind: "similarity", label, bytes: 15, repeated: false })) });

describe("private memory evaluation privacy boundary", () => {
  it("refuses CI even empty, before git, inputs, modules, providers or output creation", async () => {
    const loadInputs = vi.fn(), loadModules = vi.fn();
    for (const CI of ["", "1"]) await expect(privateMain({ private: true }, { root: sentinel, env: { CI }, loadInputs, loadModules })).rejects.toThrow("private_ci_refused");
    expect(loadInputs).not.toHaveBeenCalled(); expect(loadModules).not.toHaveBeenCalled();
    const child = spawnSync(process.execPath, [join(root, "scripts/memory-e2e-benchmark.mjs"), "--private", "--private-input-root", sentinel], { cwd: root, env: { ...process.env, CI: "" }, encoding: "utf8" });
    expect(child.status).toBe(1); expect(child.stdout).toBe(""); expect(child.stderr.trim()).toBe("private_ci_refused");
  });
  it("requires all absolute roots with no checkout-owned fallback", async () => {
    const f = await fixture(); const loadInputs = vi.fn(), loadModules = vi.fn();
    for (const outputRoot of [undefined, "relative-output"]) await expect(validatePrivateRoots({ ...f, outputRoot })).rejects.toThrow("private_absolute_roots_required");
    await expect(privateMain({ private: true, "private-mode": "retrieval" }, { root, env: {}, repositories: f.repositories, loadInputs, loadModules })).rejects.toThrow("private_absolute_roots_required");
    expect(loadInputs).not.toHaveBeenCalled(); expect(loadModules).not.toHaveBeenCalled();
    expect(await readdir(f.dir)).toEqual(expect.arrayContaining(["input", "source", "repository"]));
    expect((await readdir(f.dir)).includes("output")).toBe(false);
  });
  it("rejects repository paths and symlink/existing-ancestor aliases before reads", async () => {
    const f = await fixture();
    await expect(validatePrivateRoots({ ...f, outputRoot: join(f.repositories[0], "new", "output") })).rejects.toThrow("private_repository_path");
    await symlink(f.repositories[0], join(f.dir, "alias"));
    await expect(validatePrivateRoots({ ...f, outputRoot: join(f.dir, "alias", "new", "output") })).rejects.toThrow("private_repository_path");
    await symlink(f.repositories[0], join(f.inputRoot, "transcript-alias"));
    await expect(validatePrivateRoots(f)).rejects.toThrow("private_unsafe_entry");
  });
  it("rejects permissive roots/files, root overlap, and unsafe output ancestors", async () => {
    const f = await fixture(); await chmod(f.inputRoot, 0o755);
    await expect(validatePrivateRoots(f)).rejects.toThrow("private_permissions"); await chmod(f.inputRoot, 0o700);
    await writeFile(join(f.inputRoot, "fictional.json"), "{}", { mode: 0o644 });
    await expect(validatePrivateRoots(f)).rejects.toThrow("private_permissions"); await chmod(join(f.inputRoot, "fictional.json"), 0o600);
    await expect(validatePrivateRoots({ ...f, outputRoot: join(f.inputRoot, "output") })).rejects.toThrow("private_roots_overlap");
    const shared = join(f.dir, "shared"); await mkdir(shared, { mode: 0o755 });
    await expect(validatePrivateRoots({ ...f, outputRoot: join(shared, "output") })).rejects.toThrow("private_permissions");
    expect(await validatePrivateRoots(f)).toMatchObject({ inputRoot: f.inputRoot, storeRoot: f.storeRoot });
  });
  it("rejects macOS ACL grants even with 0700 mode bits", async (context) => {
    if (process.platform !== "darwin") context.skip(true, "private_acl_test_unsupported_platform");
    const f = await fixture();
    setFictionalAcl(f.inputRoot, "everyone allow read", context);
    await expect(validatePrivateRoots(f)).rejects.toThrow("private_permissions");
  });
  it("verifies fictional macOS ACL metadata, including deny-only, xattrs and unrecognized rows", () => {
    // Mock metadata, not host identities; this parser contract runs everywhere.
    const header = "drwxr-xr-x+ 3 fictional fictional 96 Jan 1 00:00 fictional-directory\n";
    const deny = " 0: group:everyone deny delete\n";
    expect(() => validatePrivateAclMetadata(header + deny, true)).not.toThrow();
    expect(() => validatePrivateAclMetadata(header.replace("+", "@") + deny, true)).not.toThrow();
    expect(() => validatePrivateAclMetadata(header + " 0: group:everyone inherited deny delete,file_inherit\n", true)).not.toThrow();
    expect(() => validatePrivateAclMetadata(header + deny)).toThrow("private_permissions");
    expect(() => validatePrivateAclMetadata(header.replace("+", "@"))).not.toThrow();
    for (const metadata of [
      header,
      header + " 0: group:everyone allow delete_child\n",
      header.replace("+", "@") + " 0: group:everyone allow delete_child\n",
      header + " 0: group:everyone grant delete_child\n",
      header + " 0: group:everyone deny unknown_permission\n",
      header + " 0: group:everyone deny delete,unknown_flag\n",
      header + "unrecognized ACL metadata\n",
      header + " 1: group:everyone deny delete\n",
      header + deny + " 1: user:fictional allow add_file\n",
      header + deny + deny,
      "unknown_mode 3 fictional fictional\n" + deny,
      null,
    ]) expect(() => validatePrivateAclMetadata(metadata, true)).toThrow("private_permissions");
  });
  it("accepts a verified deny-only higher ancestor ACL but still refuses ACLs on the nearest private root", async (context) => {
    if (process.platform !== "darwin") context.skip(true, "private_acl_test_unsupported_platform");
    const f = await fixture(); const ancestor = join(f.dir, "fictional-deny-ancestor"), nearest = join(ancestor, "private-nearest");
    const inputRoot = join(nearest, "input"), outputRoot = join(nearest, "output");
    await mkdir(inputRoot, { recursive: true, mode: 0o700 }); await chmod(ancestor, 0o755);
    setFictionalAcl(ancestor, "everyone deny delete", context);
    expect(await validatePrivateRoots({ ...f, inputRoot, outputRoot })).toMatchObject({ inputRoot, outputRoot });
    setFictionalAcl(inputRoot, "everyone deny delete", context);
    await expect(validatePrivateRoots({ ...f, inputRoot, outputRoot })).rejects.toThrow("private_permissions");
  });
  for (const kind of ["input", "output"]) it(`refuses a non-inheriting ancestor ACL above the ${kind} root before input loading`, async (context) => {
    if (process.platform !== "darwin") context.skip(true, "private_acl_test_unsupported_platform");
    const f = await fixture(); const ancestor = join(f.dir, "fictional-acl-ancestor"), nearest = join(ancestor, "private-nearest");
    await mkdir(nearest, { recursive: true, mode: 0o700 }); await chmod(ancestor, 0o755);
    const inputRoot = kind === "input" ? join(nearest, "input") : f.inputRoot;
    const outputRoot = kind === "output" ? join(nearest, "output") : f.outputRoot;
    if (kind === "input") await mkdir(inputRoot, { mode: 0o700 });
    expect(await validatePrivateRoots({ ...f, inputRoot, outputRoot })).toMatchObject({ inputRoot, outputRoot });
    // No inheritance flags: the root/nearest directory stays ACL-free. A named
    // mutation grant on this higher ancestor bypasses its non-writable mode.
    setFictionalAcl(ancestor, "everyone allow add_file,add_subdirectory,delete_child", context);
    expect((await lstat(ancestor)).mode & 0o777).toBe(0o755);
    const loadInputs = vi.fn(), loadModules = vi.fn(), prepareBuild = vi.fn();
    await expect(privateMain({ private: true, "private-mode": "retrieval", "private-input-root": inputRoot, "private-output-root": outputRoot, "private-store-root": f.storeRoot },
      { root, env: {}, repositories: f.repositories, loadInputs, loadModules, prepareBuild })).rejects.toThrow("private_permissions");
    expect(loadInputs).not.toHaveBeenCalled(); expect(loadModules).not.toHaveBeenCalled(); expect(prepareBuild).not.toHaveBeenCalled();
    expect(await readdir(f.repositories[0])).toEqual([]);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses SDK logging variables of any value before inputs or any admitted Pi runtime construction", async () => {
    const loadInputs = vi.fn(), loadModules = vi.fn(), prepareBuild = vi.fn();
    const createMonoRuntime = vi.fn(() => { console.debug(sentinel); throw new Error(sentinel); });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const key of PRIVATE_LOGGING_ENV) for (const value of ["", "off", "debug", "fictional-invalid-level"]) {
      const env = { [key]: value };
      expect(() => assertPrivateProviderEnvironment(env)).toThrow("private_isolation_required");
      await expect(privateMain({ private: true, "private-mode": "capture" }, { root, env, loadInputs, loadModules, prepareBuild })).rejects.toThrow("private_isolation_required");
      vi.stubEnv(key, value);
      // One shared guard protects every built-in SDK route, including all
      // OpenAI-compatible providers; no real SDK/auth/provider is constructed.
      for (const provider of ["anthropic", "openai", "openai-codex", "azure-openai-responses", "google", "google-vertex", "amazon-bedrock", "openrouter", "groq", "xai"]) {
        expect(() => privateCompletionRuntime({ runtime: { createMonoRuntime } }, `${provider}:fictional-model`, root, {})).toThrow("private_isolation_required");
      }
      vi.unstubAllEnvs();
    }
    expect(loadInputs).not.toHaveBeenCalled(); expect(loadModules).not.toHaveBeenCalled(); expect(prepareBuild).not.toHaveBeenCalled();
    expect(createMonoRuntime).not.toHaveBeenCalled(); expect(debug).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it("accepts writable sticky ancestry only for root, never a different directory owner", () => {
    const uid = process.getuid(); const foreign = uid + 1;
    const info = (owner, mode) => ({ uid: owner, mode, isDirectory: () => true });
    expect(() => requirePrivateAncestor(info(foreign, 0o1777), uid)).toThrow("private_permissions");
    expect(() => requirePrivateAncestor(info(foreign, 0o755), uid)).toThrow("private_permissions");
    if (uid !== 0) expect(() => requirePrivateAncestor(info(uid, 0o1777), uid)).toThrow("private_permissions");
    expect(() => requirePrivateAncestor(info(0, 0o777), uid)).toThrow("private_permissions");
    expect(() => requirePrivateAncestor(info(0, 0o1777), uid)).not.toThrow();
    expect(() => requirePrivateAncestor(info(uid, 0o755), uid)).not.toThrow();
  });
  it("rechecks output ancestry after creation/build and refuses a repository alias before reading inputs", async () => {
    const f = await fixture(); const parent = join(f.dir, "private-parent"); await mkdir(parent, { mode: 0o700 });
    const outputRoot = join(parent, "output"), loadInputs = vi.fn(), loadModules = vi.fn();
    const prepareBuild = async () => {
      await rename(parent, join(f.dir, "moved-parent")); await symlink(f.repositories[0], parent); return null;
    };
    await expect(privateMain({ private: true, "private-mode": "retrieval", "private-input-root": f.inputRoot, "private-output-root": outputRoot, "private-store-root": f.storeRoot },
      { root, env: {}, repositories: f.repositories, stdout() {}, prepareBuild, loadInputs, loadModules })).rejects.toThrow("private_repository_path");
    expect(loadInputs).not.toHaveBeenCalled(); expect(loadModules).not.toHaveBeenCalled();
    expect(await readdir(f.repositories[0])).toEqual([]);
    await expect(createPrivateOutput(outputRoot, f.repositories)).rejects.toThrow("private_repository_path");
  });
  it("rechecks before each canonical clone write after an ancestor is replaced", async () => {
    const f = await fixture(); const parent = join(f.dir, "private-parent"); await mkdir(parent, { mode: 0o700 });
    await writeFile(join(f.storeRoot, "daily", "2029-01-01.md"), grammar.serializeBullet(bullet("fictional", "2029-01-01T00:00:00.000Z")), { mode: 0o600 });
    const swappedGrammar = { ...grammar, parseDailyFile(text) {
      renameSync(parent, join(f.dir, "moved-parent")); symlinkSync(f.repositories[0], parent); return grammar.parseDailyFile(text);
    } };
    await expect(reconstructClone({ source: f.storeRoot, destination: join(parent, "clone"), asOf: "2030-01-01T00:00:00.000Z", grammar: swappedGrammar, repositories: f.repositories })).rejects.toThrow("private_repository_path");
    expect(await readdir(f.repositories[0])).toEqual([]);
    expect(await readFile(join(f.storeRoot, "daily", "2029-01-01.md"), "utf8")).toContain(sentinel);
  });
  it("serializes only explicitly allowed enums, numbers, opaque ids and labels", () => {
    const source = row(1, "current-only"); source.transcript = sentinel; source.response = sentinel; source.content = sentinel;
    source.lines[0].text = sentinel; source.path = sentinel;
    const serialized = serializePrivateArtifact("observations", [source]);
    expect(serialized).not.toContain(sentinel); expect(serialized).not.toContain("text");
    expect(() => serializePrivateArtifact("observations", [{ ...source, status: sentinel }])).toThrow();
    expect(() => serializePrivateArtifact("review", [{ id: sentinel, label: "useful" }])).toThrow();
    expect(serializePrivateArtifact("error", { code: "private_operation_failed", message: sentinel })).not.toContain(sentinel);
    expect(privateCode(new Error(sentinel))).toBe("private_operation_failed");
    expect(new PrivateError(sentinel).message).toBe("private_operation_failed");
  });
  it("validates private format, transcript baseline provenance, opaque annotations and preregistration minima", () => {
    expect(validateTurns(turns())).toHaveLength(3); expect(validateRegistration(registration())).toBeTruthy();
    const bad = turns(); delete bad[0].baselineSource; expect(() => validateTurns(bad)).toThrow("private_input_invalid");
    expect(() => validateTurns([...turns()].reverse())).toThrow("private_input_invalid");
    expect(() => validateRegistration({ ...registration(), minimumTurns: 399 })).toThrow("private_preregistration_invalid");
    expect(() => validateRegistration({ ...registration(), minimumJudgedFollowUpLines: 99 })).toThrow();
    expect(() => validateAnnotations([{ id: opaque(1), label: "useful", text: sentinel }])).toThrow("private_annotations_invalid");
  });
  it("reconstructs created-before-turn daily Markdown only and flags later edits/supersession", async () => {
    const f = await fixture(); const daily = join(f.storeRoot, "daily", "2029-01-01.md");
    await writeFile(daily, [bullet("old", "2029-01-01T00:00:00.000Z", "invalidated"), bullet("future", "2031-01-01T00:00:00.000Z")].map(grammar.serializeBullet).join("\n"), { mode: 0o600 });
    await utimes(daily, new Date("2031-01-01"), new Date("2031-01-01"));
    await mkdir(join(f.storeRoot, "audit"), { mode: 0o700 }); await writeFile(join(f.storeRoot, "audit", "ignored.md"), sentinel, { mode: 0o600 });
    const clone = join(f.dir, "clone");
    const evidence = await reconstructClone({ source: f.storeRoot, destination: clone, asOf: "2030-01-01T00:00:00.000Z", repositories: f.repositories, grammar });
    const parsed = grammar.parseDailyFile(await readFile(join(clone, "daily", "2029-01-01.md"), "utf8"));
    expect(parsed.bullets.map((entry) => entry.id)).toEqual(["old"]);
    expect(evidence).toMatchObject({ count: 1, contaminated: true });
    expect(evidence.flags).toEqual(expect.arrayContaining(["later_file_edit_possible", "later_status_or_supersession_possible", "rewrite_history_unknown"]));
    expect(await readdir(clone)).toEqual(["daily"]);
    const present = await reconstructClone({ source: f.storeRoot, destination: join(f.dir, "present"), asOf: "2030-01-01T00:00:00.000Z", repositories: f.repositories, grammar, present: true });
    expect(present).toMatchObject({ count: 2, contaminated: true, flags: ["diagnostic_present_store"] });
    expect((await lstat(join(clone, "daily", "2029-01-01.md"))).mode & 0o077).toBe(0);
  });
  it("reconstructs canonical graph endpoints without future/orphan associations", async () => {
    const f = await fixture();
    await writeFile(join(f.storeRoot, "daily", "2029-01-01.md"), grammar.serializeBullet(bullet("old", "2029-01-01T00:00:00.000Z")), { mode: 0o600 });
    const records = [
      { kind: "entity", id: "person:morgan", name: "Morgan", createdAt: "2029-01-01T00:00:00.000Z", updatedAt: "2031-01-01T00:00:00.000Z" },
      { kind: "entity", id: "person:avery", name: "Avery", createdAt: "2031-01-01T00:00:00.000Z" },
      { kind: "association", memoryId: "old", entityId: "person:morgan", provenance: "capture", createdAt: "2029-01-01T00:00:00.000Z" },
      { kind: "association", memoryId: "future", entityId: "person:avery", provenance: "capture", createdAt: "2031-01-01T00:00:00.000Z" },
    ];
    await writeFile(join(f.storeRoot, "graph.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"), { mode: 0o600 });
    const destination = join(f.dir, "clone");
    const evidence = await reconstructClone({ source: f.storeRoot, destination, asOf: "2030-01-01T00:00:00.000Z", repositories: f.repositories, grammar, graph });
    const projected = graph.parseCanonicalGraphStrict(await readFile(join(destination, "graph.jsonl"), "utf8"));
    expect(projected.entities.map((entity) => entity.id)).toEqual(["person:morgan"]); expect(projected.associations).toHaveLength(1);
    expect(evidence.flags).toContain("later_graph_edit_possible");
  });
  it("observes actual invoked profile/guidance/similarity and repeated bytes, not selected hits", () => {
    const content = `## Owner profile (current owner-stated background)\n- Morgan enjoys pottery.\n\n## Memory (background — not direct evidence)\n- Avery prefers brief answers.\n\n## Memory (possibly relevant — may be unrelated; verify before relying)\n- ${sentinel}`;
    const block = { content }; const messages = [{ role: "user", content: `query\n\n[Recalled long-term memory — background context for this turn, not the user's words:]\n${content}` }];
    const seen = new Set(); const first = invokedMemoryObservation({ block, messages, seen });
    expect(first.lines.map((line) => line.kind)).toEqual(["profile", "guidance", "similarity"]); expect(first.repeatedBytes).toBe(0);
    expect(invokedMemoryObservation({ block, messages, seen }).repeatedBytes).toBe(first.lines.reduce((sum, line) => sum + line.bytes, 0));
    expect(invokedMemoryObservation({ block, messages: [{ role: "user", content: "not invoked" }] }).invoked).toBe(false);
  });
  it("detects unsupported flags through normalization and maps arms through config deltas only", async () => {
    const modules = await productionModules({ privateEvaluation: true });
    const json = { runtime: { model: "openai:gpt-4o" }, context: { identityPath: "IDENTITY.md" }, memory: { path: "memory", mode: "bujo", writeMode: "disabled", embeddings: { provider: "ollama", model: "fictional", dim: 3 }, llm: { provider: "ollama", model: "fictional" } } };
    const current = resolvePrivateArm(modules, json, root, "current-only");
    expect(current.status).toBe("completed");
    expect(current.config.memory.recall).toEqual({ contextWindow: false, semanticOnly: false });
    const semantic = resolvePrivateArm(modules, json, root, "semantic-only");
    expect(semantic.status).toBe("completed");
    expect(semantic.config.memory.recall).toEqual({ contextWindow: false, semanticOnly: true });
    expect(semantic.config.memory.profile).toEqual({ enabled: false });
    const unknown = structuredClone(json); unknown.memory.recall = { fictionalUnsupportedFlag: true };
    expect(() => modules.config.resolveJsonMonoAgentConfig({ json: unknown, cwd: root })).toThrow();
    expect(resolvePrivateArm(modules, unknown, root, "semantic-only")).toEqual({ status: "unsupported" });
    const window = resolvePrivateArm(modules, json, root, "follow-up-window");
    expect(window.config.memory.recall).toEqual({ contextWindow: true, semanticOnly: false });
    expect(window.config.memory.profile).toEqual({ enabled: false });
    expect(resolvePrivateArm(modules, json, root, "window-profile-on").config.memory.profile.enabled).toBe(true);
  });
  it("requires an exact declared/allowed production route for Pi, and refuses content sinks", () => {
    const r = registration(); r.productionRoutes = ["openai:fictional-model"];
    const runtime = { isPiBuiltinProvider: (provider) => provider === "openai" };
    expect(() => validatePrivateRoute("openai:fictional-model", [], r, runtime)).toThrow("private_provider_route_refused");
    expect(() => validatePrivateRoute("openai:another-model", ["openai:another-model"], r, runtime)).toThrow();
    expect(validatePrivateRoute("openai:fictional-model", ["openai:fictional-model"], r, runtime)).toMatchObject({ provider: "agent-host", trace: false });
    expect(validatePrivateRoute("ollama:fictional", [], r, runtime).endpoint).toBe("http://127.0.0.1:11434");
    for (const options of [{ piSessionsRoot: sentinel }, { onEvent() {} }, { observers: [{}] }, { persistArtifact() {} }]) expect(() => assertPrivateRuntimeOptions(options)).toThrow("private_isolation_required");
    expect(parseArguments(["--private", "--allow-private-provider-route", "openai:fictional-model", "--allow-private-provider-route", "ollama:fictional"])["allow-private-provider-route"]).toHaveLength(2);
  });
});

describe("private memory evaluation measurement", () => {
  it("writes blinded sheets containing only opaque IDs and labels", () => {
    const sheets = blindSheets([row(1, "current-only"), row(2, "profile-on")]);
    expect(sheets).toHaveLength(4);
    expect(sheets.every((item) => Object.keys(item).join() === "id,label" && item.label === null)).toBe(true);
    expect(JSON.stringify(sheets)).not.toContain("profile");
  });
  it("computes paired conversation bootstrap 95% intervals, with stable differences", () => {
    const a = Array.from({ length: 400 }, (_, i) => row(i, "current-only", "noise"));
    const b = Array.from({ length: 400 }, (_, i) => row(i, "follow-up-window", "useful"));
    const result = pairedBootstrap(a, b, { iterations: 200 });
    expect(result.conversations).toBe(40); expect(result.metrics.usefulCoverage).toEqual({ difference: 1, low: 1, high: 1 });
    expect(result.metrics.noiseRate).toEqual({ difference: -1, low: -1, high: -1 });
    expect(pairedBootstrap(a.slice(0, 10), b.slice(0, 10)).metrics.usefulCoverage).toBeNull();
    expect(pairedBootstrap(a, b.slice(0, 200), { iterations: 200 }).conversations).toBe(20);
    expect(metrics([row(1, "current-only", "partial")])).toMatchObject({ usefulPrecision: 0, partialRate: 1, usefulCoverage: 0 });
  });
  it("declares insufficient counts/unjudged/contaminated evidence inconclusive and unsupported arms honestly", () => {
    const a = Array.from({ length: 400 }, (_, i) => row(i, "current-only")); const b = Array.from({ length: 400 }, (_, i) => row(i, "follow-up-window"));
    expect(summarizePrivate([...a, ...b], registration()).status).toBe("measured");
    expect(summarizePrivate([...a.slice(0, 399), ...b], registration()).status).toBe("inconclusive");
    const fewFollow = a.map((entry, i) => ({ ...entry, followUp: i < 49 })); expect(summarizePrivate(fewFollow, registration()).status).toBe("inconclusive");
    const fewLines = a.map((entry, i) => ({ ...entry, lines: i < 50 ? entry.lines.slice(0, 1) : entry.lines })); expect(summarizePrivate(fewLines, registration()).status).toBe("inconclusive");
    const unjudged = a.map((entry, i) => i === 0 ? { ...entry, lines: [{ ...entry.lines[0], label: null }] } : entry); expect(summarizePrivate(unjudged, registration()).status).toBe("inconclusive");
    const contaminated = a.map((entry) => ({ ...entry, contaminated: true })); expect(summarizePrivate(contaminated, registration(), "strict").status).toBe("inconclusive");
    const abstention = a.map((entry) => ({ ...entry, arm: "length-only-abstention", lines: [], bytes: 0 }));
    const abstentionPair = summarizePrivate([...a, ...b, ...abstention], registration()).comparisons.find((pair) => pair.baseline === "length-only-abstention");
    expect(abstentionPair.status).toBe("measured"); expect(abstentionPair.metrics.usefulCoverage.low).toBe(1); expect(abstentionPair.metrics.usefulPrecision).toBeNull();
    const unsupported = a.map((entry) => ({ ...entry, arm: "semantic-only", status: "unsupported", lines: [] }));
    expect(summarizePrivate([...a, ...unsupported], registration()).arms.find((entry) => entry.arm === "semantic-only").status).toBe("unsupported");
  });
  it("replays fictional turns through real config/store/harness without loading private inputs or persisting sentinels", async () => {
    const f = await fixture();
    const unlabelled = bullet("fictional-note", "2029-01-01T00:00:00.000Z");
    const knowledge = { ...unlabelled, id: "fictional-knowledge",
      refs: [encodeMemoryLabel({ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" })] };
    const episode = { ...knowledge, id: "fictional-episode", type: "event" };
    // Equal text/scores keep every source inside the existing relevance window.
    // The semantic arm must inject only the labelled note, not the other sources.
    await writeFile(join(f.storeRoot, "daily", "2029-01-01.md"), [unlabelled, knowledge, episode].map(grammar.serializeBullet).join("\n") + "\n", { mode: 0o600 });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(url).toBe("http://127.0.0.1:11434/api/embed");
      const input = JSON.parse(options.body).input;
      return new Response(JSON.stringify({ embeddings: input.map(() => [1, 0, 0]) }), { headers: { "content-type": "application/json" } });
    });
    const loadModules = async () => {
      const modules = await productionModules({ privateEvaluation: true });
      return { ...modules, controllerMemory: { ...modules.controllerMemory, ensureSharedMemoryRetrieval(controller, config, store) {
        expect(store.tier()).toBe("bujo");
        const service = modules.controllerMemory.ensureSharedMemoryRetrieval(controller, config, store);
        const load = service.load.bind(service);
        service.load = (...args) => { expect(args[2].traceContent).toBe(false); expect(typeof args[2].onWarning).toBe("function"); return load(...args); };
        return service;
      } } };
    };
    const stdout = vi.fn(); const review = vi.fn(async (items) => items.map(({ id }) => ({ id, label: "useful" })));
    const loadInputs = vi.fn(async () => ({ turns: validateTurns(turns()), registration: registration() }));
    await privateMain({ private: true, "private-mode": "retrieval", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot, "private-store-root": f.storeRoot,
      "private-dimension": "3", "private-review": true }, { root, env: {}, repositories: f.repositories, stdout, loadInputs, review, loadModules, prepareBuild: async () => null });
    expect(network).toHaveBeenCalled(); expect(loadInputs).toHaveBeenCalledOnce(); expect(review).toHaveBeenCalledOnce();
    expect(stdout.mock.calls).toEqual([["private_completed"]]);
    const names = await readdir(f.outputRoot); expect(names).toContain("review.json"); expect(names.some((name) => name.startsWith("clone-"))).toBe(false);
    for (const name of names) { expect(await readFile(join(f.outputRoot, name), "utf8")).not.toContain(sentinel); expect((await lstat(join(f.outputRoot, name))).mode & 0o077).toBe(0); }
    const observed = JSON.parse(await readFile(join(f.outputRoot, "observations.json"), "utf8"));
    const semantic = observed.filter((entry) => entry.arm === "semantic-only");
    expect(semantic).toHaveLength(turns().length);
    expect(semantic.every((entry) => entry.status === "completed" && entry.bytes > 0 && entry.indexingEmbeddingRequests > 0)).toBe(true);
    for (const [id, kind] of [[opaque(1), "similarity"], [opaque(2), "guidance"], [opaque(3), "similarity"]]) {
      expect(semantic.find((entry) => entry.id === id).lines.map((line) => line.kind)).toEqual([kind]);
    }
    const current = observed.find((entry) => entry.arm === "current-only" && entry.id === opaque(1));
    expect(current.bytes).toBeGreaterThan(semantic[0].bytes);
    // Legacy text dedup selects one similarity source; scoped guidance is separate.
    expect(current.lines).toHaveLength(2);
    expect(current.lines.filter((line) => line.kind === "similarity")).toHaveLength(1);
    expect(current.lines.filter((line) => line.kind === "guidance")).toHaveLength(1);
    expect(JSON.parse(await readFile(join(f.outputRoot, "summary-unjudged.json"), "utf8"))[1].status).toBe("inconclusive");
    expect((await readFile(join(f.storeRoot, "daily", "2029-01-01.md"), "utf8"))).toContain(sentinel);
  }, 30000);
  it("captures chronologically into disposable source-clock clones and keeps responses out of artifacts", async () => {
    const f = await fixture(); const capturedDates = [], admissions = [], calls = [];
    const captureTurns = turns().map((turn, index) => ({ ...turn, ownerText: ["Morgan chose a blue pottery wheel.", "Avery chose a green pottery wheel.", "Morgan prefers matte glazes."][index] }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body); calls.push(url.endsWith("/api/embed") ? "embed" : "generate");
      if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
      expect(url).toBe("http://127.0.0.1:11434/api/generate"); expect(options.redirect).toBe("error");
      let response;
      if (body.prompt.includes("\nTURN:\n")) {
        const user = body.prompt.split("\nTURN:\n").at(-1).split("\nAssistant:")[0];
        response = { memories: [{ type: "note", text: user, salience: 0.9, isInsight: false, entityIds: [], source: "user" }], entities: [], relations: [] };
      } else if (body.prompt.includes("LINES:\n")) response = { decisions: [{ index: 0, decision: "none" }] };
      else {
        const indexes = [...new Set([...body.prompt.matchAll(/"index"\s*:\s*(\d+)/gu)].map((match) => Number(match[1])))];
        response = { decisions: indexes.map((index) => ({ index, action: "add" })) };
      }
      return new Response(JSON.stringify({ response: JSON.stringify(response) }));
    });
    const loadModules = async () => {
      const modules = await productionModules({ privateEvaluation: true });
      return { ...modules, app: { ...modules.app, async createConfiguredMemory(config, deps) {
        const store = await modules.app.createConfiguredMemory(config, deps); const close = store.close.bind(store);
        const persist = store.persistCompletedTurn.bind(store); store.persistCompletedTurn = async (...args) => { admissions.push(config.memory.writeMode); return persist(...args); };
        store.close = async () => {
          for (const name of await readdir(join(config.memory.path, "daily"))) for (const entry of grammar.parseDailyFile(await readFile(join(config.memory.path, "daily", name), "utf8")).bullets) capturedDates.push(entry.createdAt);
          return close();
        }; return store;
      } } };
    };
    await privateMain({ private: true, "private-mode": "capture", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot,
      "private-store-root": f.storeRoot, "private-dimension": "3", "private-capture-route": "ollama:fictional" },
      { root, env: {}, repositories: f.repositories, stdout() {}, loadModules, prepareBuild: async () => null, loadInputs: async () => ({ turns: validateTurns(captureTurns), registration: registration() }) });
    expect(admissions.length).toBeGreaterThan(0); expect(calls.filter((call) => call === "generate").length).toBeGreaterThan(0);
    expect(capturedDates).toEqual(expect.arrayContaining(turns().map((turn) => turn.timestamp)));
    const observed = JSON.parse(await readFile(join(f.outputRoot, "observations.json"), "utf8"));
    expect(observed.flatMap((entry) => entry.lines).some((line) => line.kind === "capture")).toBe(true);
    for (const name of await readdir(f.outputRoot)) expect(await readFile(join(f.outputRoot, name), "utf8")).not.toContain(sentinel);
    expect(await readdir(f.storeRoot)).toEqual(["daily"]); expect(await readdir(join(f.storeRoot, "daily"))).toEqual([]);
  }, 60000);
  it("analyzes opaque annotations without providers or turn input reads", async () => {
    const f = await fixture(); await mkdir(f.outputRoot, { mode: 0o700 });
    const observed = [row(1, "current-only"), row(1, "follow-up-window")];
    const seed = newReviewSeed();
    await writeFile(join(f.outputRoot, "review-seed.json"), JSON.stringify({ seed }), { mode: 0o600 });
    await writeFile(join(f.outputRoot, "protocol.json"), JSON.stringify({ id: reviewId(seed, "registration", validateRegistration(registration())) }), { mode: 0o600 });
    await writeFile(join(f.outputRoot, "observations.json"), serializePrivateArtifact("observations", observed), { mode: 0o600 });
    await writeFile(join(f.inputRoot, "preregistration.json"), JSON.stringify(registration()), { mode: 0o600 });
    await writeFile(join(f.inputRoot, "annotations.json"), JSON.stringify(observed[0].lines.map(({ id }) => ({ id, label: "partial" }))), { mode: 0o600 });
    const loadModules = vi.fn(), loadInputs = vi.fn();
    await privateMain({ private: true, "private-mode": "analyze", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot, "private-store-root": f.storeRoot },
      { root, env: {}, repositories: f.repositories, stdout() {}, loadModules, loadInputs });
    expect(loadModules).not.toHaveBeenCalled(); expect(loadInputs).not.toHaveBeenCalled();
    const summary = JSON.parse(await readFile(join(f.outputRoot, "summary.json"), "utf8"));
    expect(summary[1].status).toBe("inconclusive"); expect(summary[1].arms[0].metrics.partialRate).toBe(1);
    await writeFile(join(f.inputRoot, "preregistration.json"), JSON.stringify({ ...registration(), minimumTurns: 401 }), { mode: 0o600 });
    await expect(privateMain({ private: true, "private-mode": "analyze", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot, "private-store-root": f.storeRoot },
      { root, env: {}, repositories: f.repositories, stdout() {}, loadModules, loadInputs })).rejects.toThrow("private_preregistration_changed");
  });

  it("keeps the model judge off by default and stores only labels after explicit local route selection", async () => {
    const f = await fixture();
    const generated = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
      expect(url).toBe("http://127.0.0.1:11434/api/generate"); expect(options.redirect).toBe("error");
      generated.push(body.prompt); return new Response(JSON.stringify({ response: JSON.stringify({ label: "partial", ignored: sentinel }) }));
    });
    await privateMain({ private: true, "private-mode": "retrieval", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot,
      "private-store-root": f.storeRoot, "private-dimension": "3", "private-judge": "ollama:fictional" },
      { root, env: {}, repositories: f.repositories, stdout() {}, prepareBuild: async () => null, loadInputs: async () => ({ turns: validateTurns(turns()), registration: registration() }) });
    expect(generated).toHaveLength(1); expect(generated[0]).not.toContain("historical-baseline");
    const annotations = JSON.parse(await readFile(join(f.outputRoot, "model-review.json"), "utf8"));
    expect(annotations).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{32}$/u), label: "partial" }]);
    const rows = JSON.parse(await readFile(join(f.outputRoot, "observations.json"), "utf8"));
    expect(rows.flatMap((entry) => entry.lines).every((line) => line.label === null)).toBe(true);
    for (const name of await readdir(f.outputRoot)) expect(await readFile(join(f.outputRoot, name), "utf8")).not.toContain(sentinel);
  }, 30000);
  it("persists stable codes only when an injected runtime/module error contains private-looking text", async () => {
    const f = await fixture(); const stdout = vi.fn();
    await expect(privateMain({ private: true, "private-mode": "retrieval", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot, "private-store-root": f.storeRoot },
      { root, env: {}, repositories: f.repositories, stdout, prepareBuild: async () => null,
        loadInputs: async () => ({ turns: validateTurns(turns()), registration: registration() }), loadModules: async () => { throw new Error(sentinel); } })).rejects.toThrow("private_operation_failed");
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(f.outputRoot, "error.json"), "utf8"))).toEqual({ code: "private_operation_failed" });
  });

  it("refuses real 307/308 embedding redirects during indexing and configured-store query retrieval", async () => {
    for (const status of [307, 308]) for (const stage of ["indexing", "query"]) {
      const f = await fixture(); let forwarded = 0, received = 0;
      const sink = createServer(async (request, response) => {
        forwarded += 1; const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
      });
      await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
      const redirect = createServer(async (request, response) => {
        received += 1; const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (stage === "query" && received === 1) {
          response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) })); return;
        }
        response.writeHead(status, { location: `http://127.0.0.1:${sink.address().port}/different-receiver` }); response.end(sentinel);
      });
      await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
      try {
        await writeFile(join(f.storeRoot, "daily", "2029-01-01.md"), grammar.serializeBullet(bullet("fictional", "2029-01-01T00:00:00.000Z")), { mode: 0o600 });
        const endpoint = `http://127.0.0.1:${redirect.address().port}`;
        const loadModules = async () => {
          const modules = await productionModules({ privateEvaluation: true });
          return { ...modules,
            search: { ...modules.search, createEmbeddingProvider(config, transport) { return modules.search.createEmbeddingProvider({ ...config, endpoint }, transport); } },
            app: { ...modules.app, createConfiguredMemory(config, deps) {
              expect(typeof deps.embeddingsFetch).toBe("function");
              return modules.app.createConfiguredMemory({ ...config, memory: { ...config.memory, embeddings: { ...config.memory.embeddings, endpoint } } }, deps);
            } },
          };
        };
        const error = await privateMain({ private: true, "private-mode": "retrieval", "private-input-root": f.inputRoot, "private-output-root": f.outputRoot, "private-store-root": f.storeRoot, "private-dimension": "3" },
          { root, env: {}, repositories: f.repositories, stdout() {}, loadModules, prepareBuild: async () => null,
            loadInputs: async () => ({ turns: validateTurns(turns()), registration: registration() }) }).catch((failure) => failure);
        expect(error, `${status}:${stage}`).toBeInstanceOf(PrivateError); expect(received).toBeGreaterThan(stage === "query" ? 1 : 0); expect(forwarded).toBe(0);
        const artifact = await readFile(join(f.outputRoot, "error.json"), "utf8"); expect(artifact).not.toContain(sentinel);
        expect(Object.keys(JSON.parse(artifact))).toEqual(["code"]);
      } finally {
        await Promise.all([redirect, sink].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
      }
    }
  }, 60000);
  it("reports constant per-day capture yield as point-only with no bootstrap interval", () => {
    const baseline = Array.from({ length: 40 }, (_, i) => ({ ...row(i, "current-only"), conversationId: opaque(20000 + i), dayId: opaque(30000 + i) }));
    const candidate = baseline.map((entry, i) => ({ ...entry, arm: "follow-up-window", lines: [...entry.lines, { id: opaque(40000 + i), kind: "capture", label: "useful", bytes: 20, repeated: false }] }));
    const paired = pairedBootstrap(baseline, candidate, { iterations: 200 });
    expect(paired.conversations).toBe(40);
    for (const key of ["capturedLinesPerDay", "captureUsefulLinesPerDay"]) expect(paired.metrics[key]).toEqual({ difference: 1, interval: "no interval" });
    expect(paired.metrics.captureNoiseLinesPerDay).toEqual({ difference: 0, interval: "no interval" });
    expect(paired.metrics.usefulCoverage).toEqual({ difference: 0, low: 0, high: 0 });
    const summary = summarizePrivate([...baseline, ...candidate], registration());
    const artifact = JSON.parse(serializePrivateArtifact("summary", [summary]));
    expect(artifact[0].comparisons[0].metrics.capturedLinesPerDay).toEqual({ difference: 1, interval: "no interval" });
  });

});
