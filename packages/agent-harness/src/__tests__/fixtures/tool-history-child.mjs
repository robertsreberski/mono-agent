const [sourceModuleUrl, root, ceilingText, mode] = process.argv.slice(2);
const { ToolHistoryWriter } = await import(sourceModuleUrl);
const { Worker } = await import("node:worker_threads");
console.log("SOURCE_ENTRY_LOADED");
const keepAlive = mode === "hold" ? setInterval(() => {}, 1_000) : undefined;
const originalWorkerRef = Worker.prototype.ref;
if (mode === "force-unref-open") {
  const originalWorkerUnref = Worker.prototype.unref;
  Worker.prototype.ref = function forceUnrefWorker() {
    originalWorkerUnref.call(this);
    return this;
  };
}
const binding = {
  conversationId: "slack:C1#2026-08-14",
  logicalConversationId: "slack:C1",
  runId: "crashed-run",
  isolated: false,
};
console.log("STARTING");
try {
  const writer = await ToolHistoryWriter.open({
    root,
    ownerAcquireCeilingMs: Number(ceilingText),
  });
  console.log("ACQUIRED");
  if (mode === "hold") {
    await writer.persist(binding, {
        phase: "invocation",
        toolCallId: "crash-call",
        toolName: "Bash",
        arguments: { command: "sleep" },
      });
    console.log("READY");
  } else if (mode === "settle") {
    const finishedBinding = { ...binding, runId: "finished-run" };
    await writer.persist(finishedBinding, {
      phase: "invocation",
      toolCallId: "finished-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    });
    await writer.persist(finishedBinding, {
      phase: "result",
      toolCallId: "finished-call",
      state: "success",
      content: "done",
    });
    console.log("PERSISTED");
    await writer.finishRun(finishedBinding, "succeeded");
    console.log("FINISHED");
    await writer.persist(binding, {
      phase: "invocation",
      toolCallId: "graceful-close-call",
      toolName: "Bash",
      arguments: { command: "waiting" },
    });
    await writer.close();
    console.log("CLOSED");
  } else if (mode === "close") {
    await writer.close();
  }
} catch (error) {
  if (keepAlive !== undefined) clearInterval(keepAlive);
  console.log(error?.code || error?.message || String(error));
  process.exitCode = error?.code === "history_writer_in_use" ? 23 : 24;
} finally {
  Worker.prototype.ref = originalWorkerRef;
}
