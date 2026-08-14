import { ToolHistoryWriter } from "../../../dist/index.js";

const [root, ceilingText, mode] = process.argv.slice(2);
const keepAlive = mode === "open-only" ? undefined : setInterval(() => {}, 1_000);
console.log("STARTING");
try {
  const writer = await ToolHistoryWriter.open({
    root,
    ownerAcquireCeilingMs: Number(ceilingText),
  });
  console.log("ACQUIRED");
  if (mode === "hold") {
    await writer.persist(
      {
        conversationId: "slack:C1#2026-08-14",
        logicalConversationId: "slack:C1",
        runId: "crashed-run",
        isolated: false,
      },
      {
        phase: "invocation",
        toolCallId: "crash-call",
        toolName: "Bash",
        arguments: { command: "sleep" },
      },
    );
    console.log("READY");
  } else if (mode === "close") {
    await writer.close();
    if (keepAlive !== undefined) clearInterval(keepAlive);
  }
} catch (error) {
  if (keepAlive !== undefined) clearInterval(keepAlive);
  console.log(error?.code || error?.message || String(error));
  process.exitCode = error?.code === "history_writer_in_use" ? 23 : 24;
}
