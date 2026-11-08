// Preloaded only into the real tool-history worker by the fictional harness test.
import { workerData } from "node:worker_threads";
import { installProcessGuard } from "./process-guard.mjs";
const port = workerData.recordedTestGuardPort;
if (!port) throw Error("fictional_worker_guard_missing");
installProcessGuard({ hit: command => port.postMessage({ kind: "allowed", command }), refuse: () => port.postMessage({ kind: "refused" }) });
port.postMessage({ kind: "ready" });
port.unref();
