import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
interface Report {
  phase?: string; presented?: { status: string }; activeAsks: number; oldAsk?: unknown; staleReply?: { accepted: boolean };
  providers: number; tools: number; inspections?: number; afterProviders?: number; afterTools?: number;
  part?: { status: string }; message?: { parts: Array<{ type: string; text?: string; result?: unknown; structuredResult?: unknown; status?: string }> };
  history?: Array<{ role: string; content: string }>; continuedHistory?: Array<{ role: string; content: string; runId?: string }>;
  continuedMessages?: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
}
const worker = fileURLToPath(new URL("./fixtures/ask-user-kill-worker.mjs", import.meta.url));
function start(root: string, mode: string) {
  const child = fork(worker, [root, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit");
  const reply = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("AskUser worker exceeded 10s")); }, 10_000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value as Report); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`AskUser worker exited ${String(code ?? signal)}: ${stderr}`)); });
  });
  return { child, reply, exited };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}
it("SIGKILL after AskUser presentation preserves its note and waits for an explicit new message", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ask-user-kill-")));
  try {
    const producer = start(root, "produce");
    let killed: Report;
    try { killed = await producer.reply; } finally { await stop(producer.child); }
    expect(producer.child.signalCode).toBe("SIGKILL"); expect(killed.phase).toBe("presented-and-persisted");
    expect(killed.presented?.status).toBe("pending"); expect(killed.activeAsks).toBe(1); expect(killed.part?.status).toBe("running");
    const recover = async (mode: string) => {
      const run = start(root, mode);
      try { const report = await run.reply; const [code] = await run.exited; expect(code).toBe(0); return report; }
      finally { await stop(run.child); }
    };
    const first = await recover("recover"), second = await recover("continue");
    const note = "The question was interrupted. Answer in a new message; no tool was replayed.";
    for (const report of [first, second]) {
      expect(report.activeAsks).toBe(0); expect(report.oldAsk).toBeNull(); expect(report.staleReply?.accepted).toBe(false);
      expect(report.providers).toBe(0); expect(report.tools).toBe(0);
      expect(report.history?.filter((message) => message.content === note)).toHaveLength(1);
      expect(report.message?.parts.filter((part) => part.type === "text" && part.text === note)).toHaveLength(1);
      expect(report.message?.parts.find((part) => part.type === "tool-call")).toMatchObject({ status: "failed" });
      expect(report.message?.parts.find((part) => part.type === "tool-call")?.result).toBeUndefined();
      expect(report.message?.parts.find((part) => part.type === "tool-call")?.structuredResult).toBeUndefined();
    }
    expect(second.history).toEqual(first.history); expect(second.message).toEqual(first.message);
    expect(first.inspections).toBe(1); expect(second.inspections).toBe(0);
    expect(second.continuedHistory?.slice(-2)).toEqual([
      expect.objectContaining({ role: "user", content: "Fictional explicit new answer.", runId: "fictional-explicit-next" }),
      expect.objectContaining({ role: "assistant", content: "Fictional new reply.", runId: "fictional-explicit-next" }),
    ]);
    expect(second.continuedMessages?.filter((message) => message.role === "user").at(-1)?.parts).toEqual([{ type: "text", text: "Fictional explicit new answer." }]);
    expect(second.afterProviders).toBe(1); expect(second.afterTools).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35_000);
