import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

interface Report {
  dispatchRoutes?: unknown[]; phase?: string; providers: number; tools: number; dispatches: number; inspections?: number;
  receipt?: { disposition: string; message: { id: string } };
  dispatch?: { id: string; dispatch_started_at: string };
  pendingIds?: string[];
  bytes?: string; queued?: string[];
  message?: { liveInputStatus: string; parts: unknown[] };
  canonical?: { messages: Array<{ role: string; content: string }>; lastCommit: { outcome: string } };
}
const worker = fileURLToPath(new URL("./fixtures/live-input-kill-worker.mjs", import.meta.url));
function start(root: string, mode: string) {
  const child = fork(worker, [root, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  const reply = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Live input worker exceeded 10s")); }, 10_000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value as Report); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Live input worker exited ${String(code ?? signal)}: ${stderr}`)); });
  });
  return { child, reply, exited };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

it("SIGKILL after Web receipt and host admission recovers unconsumed input twice without replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "live-input-kill-")));
  try {
    const producer = start(root, "produce");
    let killed: Report;
    try { killed = await producer.reply; } finally { await stop(producer.child); }
    expect(producer.child.signalCode).toBe("SIGKILL");
    expect(killed.phase).toBe("admitted-unconsumed");
    expect(killed.receipt?.disposition).toBe("pending");
    expect(killed.dispatch?.dispatch_started_at).toEqual(expect.any(String));
    expect(killed.pendingIds).toContain(killed.dispatch!.id);
    expect(killed.providers).toBe(1); expect(killed.tools).toBe(0);
    const recover = async () => {
      const run = start(root, "recover");
      try { const report = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return report; }
      finally { await stop(run.child); }
    };
    const first = await recover(), second = await recover();
    for (const report of [first, second]) {
      expect(report.message).toMatchObject({ liveInputStatus: "uncertain", parts: [{ type: "text", text: "Fictional preserved correction." }] });
      expect(report.queued).toEqual([]); // UI renders uncertain as "Delivery uncertain — not retried".
      expect(report.providers).toBe(0); expect(report.tools).toBe(0); expect(report.dispatchRoutes).toEqual([]); expect(report.dispatches).toBe(0);
      expect(report.canonical!.lastCommit.outcome).toBe("interrupted");
      expect(report.canonical!.messages.filter((message) => message.content.includes("not confirmed as applied"))).toEqual([
        expect.objectContaining({ role: "assistant", content: "Some messages sent during the previous turn (1 total) were not confirmed as applied and were not replayed. Resend them if still needed." }),
      ]);
      expect(report.canonical!.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Fictional initial task."]);
    }
    expect(first.inspections).toBe(1); expect(second.inspections).toBe(0);
    expect(second.bytes).toBe(first.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35_000);
