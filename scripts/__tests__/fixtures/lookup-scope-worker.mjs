import { Worker, parentPort, threadId, workerData } from "node:worker_threads";
import { once } from "node:events";
const scope = globalThis[Symbol.for("lookup.proof.scope")];
if (!scope) throw Error("test_scope_missing");
const canaries = scope.canaries();
let nested = null;
if (workerData.nested) {
  const child = new Worker(new URL(import.meta.url), {workerData: {nested: false}});
  [nested] = await once(child, "message"); await once(child, "exit");
}
parentPort.postMessage({threadId, canaries, nested, unexpected: scope.result().unexpected, files: scope.files.result()});
