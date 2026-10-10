// Shared driver for the configured-host model-switch SIGKILL matrix. Each
// boundary: one producer process killed at or after a real fs/provider
// boundary (the labelled operation has completed; the reporting async chain is
// parked, but unrelated in-process work may advance until SIGKILL lands), then
// two fresh-process recoveries through the same public configured host.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export type Scenario = "structured" | "return" | "cold" | "reset" | "retention" | "fallback" | "fallback-wake" | "fallback-switch" | "fallback-refusal" | "fallback-cold" | "missing" | "missing-v3" | "missing-switch";
export interface Call { readonly model: string; readonly kind: "summary" | "turn" | "tool"; readonly armed: boolean }
export interface Report {
  readonly preparedRuns?: readonly { readonly model: string; readonly armed: boolean }[];
  readonly results: readonly { readonly text?: string; readonly failure?: string; readonly warnings: readonly string[]; readonly runtimeWarnings?: readonly { readonly warning_kind: string; readonly message: string }[] }[];
  readonly calls: readonly Call[];
  readonly contexts: readonly string[];
  readonly canonical: any; readonly successor: any;
  readonly journals: Record<string, string>;
  readonly modelChanges: number; readonly toolRecords: number;
  readonly switchFiles: readonly string[]; readonly operations: readonly string[];
  readonly pending: readonly string[]; readonly dirty: readonly string[];
  readonly switchStates: readonly { switchId: string; phase: string; from: string; to: string; generation: number; authorizations: number; attempts: { producer: string; outcome: string; generation: number }[] }[];
  readonly artifacts: readonly { switchId: string; producer: string; native: boolean; summary: boolean; ledger: number; recent: number; budget: Record<string, unknown> }[];
  readonly stats: { readonly reservedBytes: number; readonly conversations: number };
}
const worker = new URL("./configured-switch-kill-worker.mjs", import.meta.url);
const preload = fileURLToPath(new URL("./configured-switch-kill-preload.cjs", import.meta.url));
const roots: string[] = [];
const live = new Set<ChildProcess>();
/** One shared deadline per test (below vitest's 60s test timeout), not per process. */
export const TEST_TIMEOUT_MS = 60_000;
const BUDGET_MS = 55_000;
/** afterEach: SIGKILL any still-live worker BEFORE deleting its root. */
export async function cleanupRoots(): Promise<void> {
  await Promise.all([...live].map((child) => stopped(child)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

function start(root: string, scenario: Scenario, mode: "produce" | "recover" | "check" | "resume", deadline: number, phase?: string): { child: ChildProcess; reply: Promise<any>; exited: Promise<unknown[]> } {
  const child = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--require", preload],
    env: { ...process.env, MONO_AGENT_FIXTURE_SCENARIO: scenario === "return" ? "native" : scenario, MONO_AGENT_FIXTURE_CRASH_PHASE: phase ?? "" } });
  live.add(child);
  const exited = once(child, "exit"); void exited.then(() => live.delete(child));
  let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Configured switch worker timed out (${mode} ${phase ?? ""}): ${stderr}`)), Math.max(1, deadline - Date.now()));
    child.once("message", (value) => { clearTimeout(timer); resolve(value); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Configured switch worker exited ${code ?? signal}: ${stderr}`)); });
  });
  child.send({ scenario: scenario === "return" ? "native" : scenario, mode });
  return { child, reply, exited };
}
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

/** SIGKILL the producer at a labelled durable boundary, then recover twice. */
export async function killAndRecover(scenario: Scenario, phase: string) {
  const deadline = Date.now() + BUDGET_MS;
  const root = await mkdtemp(join(tmpdir(), "configured-switch-kill-")); roots.push(root);
  const producer = start(root, scenario, "produce", deadline, phase);
  let killed: { phase: string; calls: Call[] };
  try { killed = await producer.reply; } finally { await stopped(producer.child); }
  expect(producer.child.signalCode).toBe("SIGKILL"); expect(killed.phase).toBe(phase);
  const before = JSON.parse(await readFile(join(root, "before.json"), "utf8")) as Report & { bytes: Record<string, string> };
  const recover = async (): Promise<Report> => {
    const run = start(root, scenario, "recover", deadline);
    try { const value = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return value; }
    finally { await stopped(run.child); }
  };
  const first = await recover(), second = await recover();
  const armed = [...killed.calls.filter((call) => call.armed), ...first.calls, ...second.calls];
  const journal = async (name: string) => (await readFile(join(root, "native", "mono-v2", "journals", name))).toString("base64");
  return { root, before, killed, first, second, armed, journal };
}

/** One later explicit message on a fresh process after the recoveries. */
export async function resumeAfter(root: string, scenario: Scenario): Promise<Report> {
  const run = start(root, scenario, "resume", Date.now() + 20_000);
  try { const value = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return value; }
  finally { await stopped(run.child); }
}

/** No leaked reservation, switch fence, lifecycle intent, P2 fence/payload or tool record. */
export function expectSettled(report: Report): void {
  expect(report.stats.reservedBytes).toBe(0);
  expect(report.switchFiles.filter((name) => name.endsWith(".fence.json") || name.endsWith(".tmp"))).toEqual([]);
  expect(report.operations).toEqual([]); expect(report.pending).toEqual([]); expect(report.dirty).toEqual([]);
  expect(report.toolRecords).toBe(0);
}
export const count = (calls: readonly Call[], kind: Call["kind"], model?: string) => calls.filter((call) => call.kind === kind && (model === undefined || call.model === model)).length;

/** Three-turn configured prepared-path check using the same real faux transport. */
export async function checkFallback(scenario: Scenario): Promise<Report & { detached: Report; receiptBefore: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "configured-fallback-check-")); roots.push(root);
  const run = start(root, scenario, "check", Date.now() + 25_000);
  try { const value = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return value; }
  finally { await stopped(run.child); }
}
