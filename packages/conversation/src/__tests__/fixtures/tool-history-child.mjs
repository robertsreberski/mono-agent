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
// Crash-recovery consumers kill this process as soon as a readiness marker is
// printed and then assert the reopened database. `persist()` returns a
// `deferred` receipt once the foreground host wait expires, so the production
// 250 ms ceiling would let readiness precede the commit under a loaded host and
// turn recovery assertions into a wall-clock race. Match the harness
// storage-test ceiling and refuse to announce readiness without a persisted id.
const STORAGE_TEST_PERSISTENCE_CEILING_MS = 5_000;
const binding = {
  conversationId: "slack:C1#2026-08-14",
  logicalConversationId: "slack:C1",
  runId: "crashed-run",
  isolated: false,
};

async function persistDurably(writer, runBinding, event) {
  const startedAt = performance.now();
  const receipt = await writer.persist(runBinding, event);
  const waitedMs = Math.round(performance.now() - startedAt);
  if (receipt?.persistence === "persisted" && typeof receipt.recordId === "string") return receipt;
  throw new Error(
    `Tool history ${event.phase} for ${event.toolCallId} was not persisted after ${String(waitedMs)} ms `
    + `(persistence=${String(receipt?.persistence)}, recordId=${String(receipt?.recordId)}, `
    + `errorCode=${String(receipt?.errorCode)}).`,
  );
}

console.log("STARTING");
try {
  const writer = await ToolHistoryWriter.open({
    root,
    ownerAcquireCeilingMs: Number(ceilingText),
    persistenceCeilingMs: STORAGE_TEST_PERSISTENCE_CEILING_MS,
  });
  console.log("ACQUIRED");
  if (mode === "hold") {
    await persistDurably(writer, binding, {
      phase: "invocation",
      toolCallId: "crash-call",
      toolName: "Bash",
      arguments: { command: "sleep" },
    });
    console.log("READY");
  } else if (mode === "settle") {
    const finishedBinding = { ...binding, runId: "finished-run" };
    await persistDurably(writer, finishedBinding, {
      phase: "invocation",
      toolCallId: "finished-call",
      toolName: "Read",
      arguments: { path: "README.md" },
    });
    await persistDurably(writer, finishedBinding, {
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
