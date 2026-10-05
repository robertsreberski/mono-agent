import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const dirs: string[] = [];
const worker = new URL("./fixtures/host-turn-reconciliation-worker.mjs", import.meta.url);
interface Reply {
  phase?: string;
  nativeConsumedIds?: string[];
  counter: number;
  providerCalls: number;
  runtimeCalls: number;
  nativeInspections: number;
  recovery: { status: string; outcome?: string };
  record: { messages: Array<{ role: string; content: string }>; lastCommit: { turnId: string; outcome: string; journalId: string }; providerSession: { epoch: string; revision: number } };
  context: unknown;
  pending: string[];
}
function receive(child: ChildProcess): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Configured recovery worker timed out: ${stderr}`)); }, 25_000);
    const onMessage = (value: Reply) => { cleanup(); resolve(value); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Configured recovery worker exited ${code}: ${stderr}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit); };
    child.once("message", onMessage); child.once("exit", onExit);
  });
}
async function run(root: string, mode: string, crash?: string): Promise<Reply> {
  const child = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const reply = receive(child), exited = once(child, "exit"); child.send({ mode, crash });
    const value = await reply; expect((await exited)[0]).toBe(0); return value;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
it.each(["native-return", "returned-tool"])("built configured host adopts whole native evidence once after SIGKILL at %s, never replays the counted effect", async (crash) => {
  const parent = fileURLToPath(new URL("../../../../.worklab-tmp/", import.meta.url)); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "host-turn-reconcile-")); dirs.push(root);
  const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const stopped = receive(producer); producer.send({ mode: "produce", crash });
    expect(await stopped).toMatchObject({ phase: crash, counter: 1 });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.nativeInspections).toBe(1);
    expect(second.providerCalls).toBe(0); expect(second.runtimeCalls).toBe(0); expect(second.nativeInspections).toBe(0);
    expect(first.counter).toBe(1); expect(second.counter).toBe(1); expect(first.pending).toEqual([]); expect(second.pending).toEqual([]);
    expect(second.record).toEqual(first.record); expect(first.record.messages).toHaveLength(2);
    expect(first.record.lastCommit.journalId).toBeTruthy();
    if (crash === "native-return") {
      expect(first.recovery).toMatchObject({ status: "recovered", outcome: "completed" });
      expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
    } else {
      expect(first.recovery).toMatchObject({ status: "interrupted", outcome: "interrupted" });
      expect(first.record.messages[1]!.content).toContain("No tools were replayed");
    }
    const next = await run(root, "continue");
    expect(next.runtimeCalls).toBe(1); expect(next.providerCalls).toBe(1); expect(next.counter).toBe(1);
    expect(JSON.stringify(next.context)).toContain("fictional-counted-effect");
    expect(JSON.stringify(next.context)).toContain("fictional-durable-signature");
    expect(next.record.messages).toHaveLength(4);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

const preload = fileURLToPath(new URL("./fixtures/host-turn-crash-preload.cjs", import.meta.url));
const earlyPhases = ["pending-partial", "pending-file", "pending-directory", "fence-file", "fence-rename", "fence-directory", "native-start", "tool-started", "mid-stream"];
const completedPhases = ["canonical-rename", "canonical-directory", "fence-cleanup", "payload-cleanup"];
function controlledWorker(root: string, phase: string): ChildProcess {
  return fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--require", preload],
    env: { ...process.env, MONO_AGENT_FIXTURE_CRASH_PHASE: phase } });
}
async function fixtureRoot(): Promise<string> {
  const parent = fileURLToPath(new URL("../../../../.worklab-tmp/", import.meta.url)); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "host-turn-matrix-")); dirs.push(root); return root;
}
it.each([...earlyPhases, "tool-effect", "tool-returned-unplaced", ...completedPhases, "legacy-unbound"])("real built host crash boundary %s settles once with no provider/tool replay", async (phase) => {
  const root = await fixtureRoot(); const producer = phase === "legacy-unbound"
    ? fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] }) : controlledWorker(root, phase);
  const count = earlyPhases.includes(phase) ? 0 : 1;
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: phase });
    expect(await ready).toMatchObject({ phase, counter: count });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.counter).toBe(count);
    expect(second.providerCalls).toBe(0); expect(second.runtimeCalls).toBe(0); expect(second.counter).toBe(count);
    expect(first.pending).toEqual([]); expect(second.pending).toEqual([]);
    expect(second.record).toEqual(first.record); expect(first.record.messages).toHaveLength(2);
    if (completedPhases.includes(phase)) {
      expect(first.nativeInspections).toBe(0); // Receipt wins at rename, before native inspection.
      expect(first.record.lastCommit.outcome).toBe("completed"); expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
    } else {
      expect(first.nativeInspections).toBe(1); expect(first.record.lastCommit.outcome).toBe("interrupted");
      expect(first.record.messages[1]!.content).toContain("No tools were replayed");
      if (phase === "tool-returned-unplaced") expect(first.record.messages[1]!.content).toContain("1 observed tool outcomes");
      if (phase === "tool-started" || phase === "tool-effect") expect(first.record.messages[1]!.content).toContain("1 unknown");
      if (phase === "legacy-unbound") expect(first.record.lastCommit.journalId).toBeNull();
    }
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("survives killing recovery itself after canonical rename and recognizes its receipt without inspecting native state again", async () => {
  const root = await fixtureRoot(); const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let recovering: ChildProcess | undefined;
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: "native-return" }); await ready;
    const killed = once(producer, "exit"); producer.kill("SIGKILL"); await killed;
    recovering = controlledWorker(root, "canonical-rename"); const stopped = receive(recovering);
    recovering.send({ mode: "recover" }); expect(await stopped).toMatchObject({ phase: "canonical-rename", counter: 1 });
    const exited = once(recovering, "exit"); recovering.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.nativeInspections).toBe(0); expect(second.nativeInspections).toBe(0);
    expect(first.providerCalls).toBe(0); expect(second.providerCalls).toBe(0); expect(first.counter).toBe(1); expect(second.counter).toBe(1);
    expect(first.record).toEqual(second.record); expect(first.record.messages).toHaveLength(2); expect(first.pending).toEqual([]);
  } finally {
    for (const child of [producer, recovering]) if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }
}, 60_000);

it("manual compaction crash repairs prior context without changing canonical messages or asking a model for a summary", async () => {
  const root = await fixtureRoot(); const producer = controlledWorker(root, "manual-start");
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: "manual-start" });
    expect(await ready).toMatchObject({ phase: "manual-start", counter: 1 });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.record.messages).toHaveLength(2); expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
    expect(first.record.lastCommit.turnId).toMatch(/^synthetic:manual:/u); expect(first.record.lastCommit.outcome).toBe("interrupted");
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(second.record).toEqual(first.record);
    expect(first.counter).toBe(1); expect(second.counter).toBe(1); expect(first.pending).toEqual([]);
    const next = await run(root, "continue"); expect(next.counter).toBe(1); expect(JSON.stringify(next.context)).toContain("fictional-counted-effect");
    expect(next.record.messages).toHaveLength(4);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("verbatim delivery after a dirty native crash settles the old turn first and records delivery once across fresh processes", async () => {
  const root = await fixtureRoot(); const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: "native-return" }); await ready;
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "verbatim"), second = await run(root, "verbatim");
    expect(first.nativeInspections).toBe(1); expect(second.nativeInspections).toBe(0);
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.counter).toBe(1); expect(second.counter).toBe(1);
    expect(second.record).toEqual(first.record); expect(first.record.messages).toHaveLength(4);
    expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
    expect(first.record.messages[3]!.content).toBe("Fictional verbatim delivery."); expect(first.pending).toEqual([]);
    expect(first.record.lastCommit.outcome).toBe("completed");
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("overflow followed by a durable compaction checkpoint remains interrupted before the final re-prompt seal", async () => {
  const root = await fixtureRoot(); const producer = controlledWorker(root, "overflow-compaction");
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: "overflow-compaction" });
    expect(await ready).toMatchObject({ phase: "overflow-compaction", counter: 1 });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.record.lastCommit.outcome).toBe("interrupted"); expect(first.record.messages).toHaveLength(4);
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.counter).toBe(1);
    expect(first.record.messages.some((message) => message.content.includes("Fictional final overflow reply."))).toBe(false);
    expect(second.record).toEqual(first.record); expect(second.nativeInspections).toBe(0);
    const next = await run(root, "continue"); expect(next.counter).toBe(1); expect(JSON.stringify(next.context)).toContain("Fictional overflow checkpoint summary.");
    expect(next.record.messages).toHaveLength(6);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("known native deletion after a committed turn fails before dispatch and uses one explicit cold attempt rather than an empty warm transcript", async () => {
  const root = await fixtureRoot(); const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const completed = receive(producer), exited = once(producer, "exit"); producer.send({ mode: "produce", crash: "native-deleted" });
    const value = await completed; expect((await exited)[0]).toBe(0);
    expect(value.counter).toBe(1); expect(value.record.messages).toHaveLength(4);
    expect(value.record.messages[3]!.content).toBe("Fictional explicit reseeded reply.");
    expect(value.runtimeCalls).toBe(3); // initial turn, pre-dispatch miss, explicit cold retry.
    expect(value.record.lastCommit.outcome).toBe("completed"); expect(value.record.lastCommit.journalId).toBeNull();
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("manual host cancellation survives release and overrides a completed native compaction seal", async () => {
  const root = await fixtureRoot(); const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash: "manual-cancelled" });
    expect(await ready).toMatchObject({ phase: "manual-cancelled", counter: 1 });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.record.lastCommit).toMatchObject({ outcome: "cancelled" });
    expect(first.record.lastCommit.turnId).toMatch(/^synthetic:manual:/u);
    expect(first.record.messages).toHaveLength(2); expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.counter).toBe(1);
    expect(first.pending).toEqual([]); expect(second.nativeInspections).toBe(0); expect(second.record).toEqual(first.record);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

for (const { crash, name } of [
  { crash: "live-input", name: "built host recovers consumed live inputs once and excludes private wake fields after a crash" },
  { crash: "live-prompt-override", name: "built host matches overridden live-input guidance digests after a crash" },
]) it(name, async () => {
  const root = await fixtureRoot(); const producer = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const ready = receive(producer); producer.send({ mode: "produce", crash });
    expect(await ready).toMatchObject({ phase: "live-consumed", nativeConsumedIds: ["fictional-human", "fictional-wake"] });
    const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited;
    const pendingRoot = join(root, ".mono-agent", "history", ".pending-turns");
    const pending = (await Promise.all((await readdir(pendingRoot)).map((name) => readFile(join(pendingRoot, name), "utf8")))).join("\n");
    expect(pending).toContain("fictional-human"); expect(pending).toContain("fictional-wake");
    for (const excluded of ["private wake body", "private-delivery-key", "memory-only body"]) expect(pending).not.toContain(excluded);
    const first = await run(root, "recover"), second = await run(root, "recover");
    expect(first.record.lastCommit.outcome).toBe("completed");
    expect(first.record.messages).toHaveLength(3);
    expect(first.record.messages[1]).toMatchObject({ role: "user", content: "Fictional ordinary follow-up." });
    for (const excluded of ["private wake body", "private-delivery-key", "memory-only body"]) expect(JSON.stringify(first.record)).not.toContain(excluded);
    expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.counter).toBe(1);
    expect(first.pending).toEqual([]); expect(second.nativeInspections).toBe(0); expect(second.record).toEqual(first.record);
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) { const exited = once(producer, "exit"); producer.kill("SIGKILL"); await exited; }
  }
}, 60_000);

it("ordinary host cancellation overrides native completion and never promotes its draft to a completed answer", async () => {
  const root = await fixtureRoot(); const first = await run(root, "produce-cancelled");
  expect(first.record.lastCommit.outcome).toBe("cancelled");
  expect(first.record.messages).toHaveLength(2); expect(first.record.messages[1]!.content).toContain("cancelled");
  expect(first.record.messages[1]!.content).not.toBe("Fictional verbatim final reply.");
  expect(first.record.messages[1]!.content).toContain("do not present partial assistant output as a completed answer");
  const second = await run(root, "recover");
  expect(second.record).toEqual(first.record); expect(second.nativeInspections).toBe(0);
  expect(second.providerCalls).toBe(0); expect(second.runtimeCalls).toBe(0); expect(second.counter).toBe(1);
}, 60_000);

async function killProduction(root: string, phase: string, preloaded = false): Promise<void> {
  const child = preloaded ? controlledWorker(root, phase) : fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const ready = receive(child); child.send({ mode: "produce", crash: phase });
    expect(await ready).toMatchObject({ phase });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}

it("recovers a durable host-built enriched candidate before canonical rename without rerunning enrichment", async () => {
  const root = await fixtureRoot(); await killProduction(root, "candidate-fence", true);
  const first = await run(root, "recover"), second = await run(root, "recover");
  expect(first.record.messages[1]!.content).toBe("Fictional verbatim final reply. Fictional host enrichment.");
  expect(first.record.lastCommit.outcome).toBe("completed"); expect(second.record).toEqual(first.record);
  expect(first.providerCalls).toBe(0); expect(first.runtimeCalls).toBe(0); expect(second.nativeInspections).toBe(0); expect(first.counter).toBe(1);
}, 60_000);

it("configured next-message admission settles a crashed turn without an explicit recovery call", async () => {
  const root = await fixtureRoot(); await killProduction(root, "native-return"); const next = await run(root, "continue");
  expect(next.nativeInspections).toBe(2); // pending old turn, then current completed turn.
  expect(next.runtimeCalls).toBe(1); expect(next.providerCalls).toBe(1); expect(next.counter).toBe(1);
  expect(next.record.messages).toHaveLength(4); expect(next.record.messages[1]!.content).toBe("Fictional verbatim final reply.");
  expect(JSON.stringify(next.context)).toContain("fictional-counted-effect");
}, 60_000);

it("native-absent recovery rotates to a fresh zero-revision epoch that accepts explicit continuation", async () => {
  const root = await fixtureRoot(); await killProduction(root, "fence-directory", true);
  const locksRoot = join(root, ".mono-agent", "history", ".locks");
  const fenceName = (await readdir(locksRoot)).find((name) => name.endsWith(".dirty.json"))!;
  const fence = JSON.parse(await readFile(join(locksRoot, fenceName), "utf8"));
  const first = await run(root, "recover"); expect(first.record.providerSession.revision).toBe(0);
  expect(first.record.providerSession.epoch).not.toBe(fence.epoch); expect(first.record.lastCommit.outcome).toBe("interrupted");
  const next = await run(root, "continue"); expect(next.runtimeCalls).toBe(1); expect(next.providerCalls).toBe(1);
  expect(next.record.messages).toHaveLength(4); expect(next.record.providerSession.epoch).toBe(first.record.providerSession.epoch);
  expect(next.record.providerSession.revision).toBe(1); expect(next.counter).toBe(0);
}, 60_000);

it("reset clears a torn unpublished initial temp after SIGKILL without inventing a native outcome", async () => {
  const root = await fixtureRoot(); await killProduction(root, "pending-initial-partial", true);
  const first = await run(root, "reset"), second = await run(root, "reset");
  expect(first.record.messages).toEqual([]); expect(first.pending).toEqual([]); expect(second.pending).toEqual([]);
  expect(first.counter).toBe(0); expect(first.nativeInspections).toBe(0); expect(first.runtimeCalls).toBe(0); expect(first.providerCalls).toBe(0);
}, 60_000);

it.each(["enriched", "silent"])("built configured P2 commits host %s completion content", async (kind) => {
  const root = await fixtureRoot(); const completed = await run(root, "produce", kind);
  expect(completed.record.lastCommit.outcome).toBe("completed");
  expect(completed.record.messages[1]!.content).toBe(kind === "silent" ? "[Host: silent completion]" : "Fictional verbatim final reply. Fictional host enrichment.");
  const repeated = await run(root, "recover"); expect(repeated.record).toEqual(completed.record); expect(repeated.nativeInspections).toBe(0);
}, 60_000);
