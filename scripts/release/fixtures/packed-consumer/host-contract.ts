import { createMonoRuntime } from "@mono-agent/agent-runtime/host";
import { parseMonoRuntimeModelReference } from "@mono-agent/agent-runtime/host/config";
import { createSandboxPolicy } from "@mono-agent/agent-runtime/host/sandbox";
import { isRuntimeSubagentActivityEvent, PI_TRANSPORTS } from "@mono-agent/agent-runtime/host/types";
import type { CreateMonoRuntimeOptions, MonoRuntimeAttemptResolution, RuntimeRunOptions, RuntimeLiveInputMessage, RuntimeNativePreparationStorage } from "@mono-agent/agent-runtime/host/types";
import { createManagedNativeJournalStorage } from "@mono-agent/agent-runtime";

const calls: string[] = [];
const message: RuntimeLiveInputMessage = { body: "fictional", accepted: () => calls.push("accepted") };
void message;
void PI_TRANSPORTS;
void isRuntimeSubagentActivityEvent({ type: "future_event" });
const policy = createSandboxPolicy({ root: "/fictional" });
const options: CreateMonoRuntimeOptions = { workspace: "/fictional", sandboxPolicy: policy };
const runtime = createMonoRuntime(options);
const run: RuntimeRunOptions = { model: parseMonoRuntimeModelReference("fictional:fixture"), messages: [], abortSignal: new AbortController().signal };
const storage: RuntimeNativePreparationStorage = createManagedNativeJournalStorage({ sessionsRoot: "/fictional/sessions" });
void storage;
if (false) {
  // @ts-expect-error host construction owns sandbox enforcement.
  createMonoRuntime({ sandbox: {} });
  // @ts-expect-error requests cannot replace the sandbox implementation.
  runtime.run("SYSTEM", { ...run, sandbox: {} });
  // @ts-expect-error deleted provider knobs are not silently accepted.
  runtime.run("SYSTEM", { ...run, settingSources: [] });
  const bad: MonoRuntimeAttemptResolution = { options: {
    // @ts-expect-error route plugins cannot replace host artifact persistence.
    persistArtifact: () => "/fictional/artifact",
  } };
  const processOwner: MonoRuntimeAttemptResolution = { options: {
    // @ts-expect-error route plugins cannot replace the process owner.
    processJobs: { start: async () => ({ jobId: "fixture", state: "queued", startedAt: null }) },
  } };
  void bad; void processOwner;
}
