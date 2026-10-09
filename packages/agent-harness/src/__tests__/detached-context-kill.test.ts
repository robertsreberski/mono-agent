import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

interface Report {
  phase?: string;
  providers: number; backups: number; inspections: number;
  paths: string[]; bytes?: string;
  history?: Array<{ content: string }>;
  pending?: { disposition?: string };
  canonical?: { messages: Array<{ content: string }>; lastCommit: { outcome: string } };
}
const worker = fileURLToPath(new URL("./fixtures/detached-context-kill-worker.mjs", import.meta.url));
function start(root: string, mode: string) {
  const child = fork(worker, [root, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  const reply = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Detached context worker exceeded 8s")); }, 8_000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value as Report); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Detached worker exited ${String(code ?? signal)}: ${stderr}`)); });
  });
  return { child, reply, exited };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

it("KA1: SIGKILL during owner-held replay after detach fsync, then recover twice without execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "detached-context-kill-"));
  try {
    const producer = start(root, "produce");
    let killed: Report;
    try { killed = await producer.reply; } finally { await stop(producer.child); }
    expect(producer.child.signalCode).toBe("SIGKILL");
    expect(killed.phase).toBe("loader"); expect(killed.providers).toBe(1); expect(killed.backups).toBe(0);
    expect(killed.inspections).toBe(0); expect(killed.history![0]!.content).toBe("Fictional prior answer");
    expect(killed.pending!.disposition).toBe("detached");
    const recover = async () => {
      const run = start(root, "recover");
      try { const report = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return report; }
      finally { await stop(run.child); }
    };
    const first = await recover(), second = await recover();
    for (const report of [first, second]) {
      expect(report.providers).toBe(0); expect(report.backups).toBe(0); expect(report.inspections).toBeLessThanOrEqual(1);
      expect(report.canonical!.lastCommit.outcome).toBe("interrupted");
      expect(report.canonical!.messages).toHaveLength(3);
      expect(report.canonical!.messages.at(-1)!.content).toContain("later attempt outcomes may be unknown");
      expect(report.paths.filter((path) => path.endsWith(".dirty.json") || path.startsWith(".pending-turns/") || path.includes(".native-history-op") || path.endsWith(".tmp"))).toEqual([]);
    }
    expect(second.inspections).toBe(0);
    expect(second.bytes).toBe(first.bytes); // No second commit or duplicate continuity.
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25_000);
