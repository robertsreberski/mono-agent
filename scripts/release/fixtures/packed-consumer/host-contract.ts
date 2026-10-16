import { createMonoRuntime } from "@mono-agent/turn/host";
import { parseMonoRuntimeModelReference, TurnHostError } from "@mono-agent/turn/host/config";
import { createSandboxPolicy } from "@mono-agent/turn/host/sandbox";
import { isRuntimeSubagentActivityEvent, PI_TRANSPORTS } from "@mono-agent/turn/host/types";
import type { CreateMonoRuntimeOptions, MonoRuntimeAttemptResolution, RuntimeRunOptions, RuntimeLiveInputMessage, RuntimeNativePreparationStorage } from "@mono-agent/turn/host/types";
import { createManagedNativeJournalStorage } from "@mono-agent/turn/ai";

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
  void createManagedNativeJournalStorage({ sessionsRoot: "/fictional/sessions" })
    .inspectCurrentJournal({ handleId: "fixture" });
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

const hostError: Error = new TurnHostError("invalid_runtime_options", "Fictional failure", { field: "fixture" });
void hostError;
if (false) {
  // @ts-expect-error unknown codes are not accepted by the host error contract.
  new TurnHostError("fictional_invalid_code", "Fictional failure");
}
