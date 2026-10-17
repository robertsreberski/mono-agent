import { createRuntime, createRouterRuntime } from "@mono-agent/turn";
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

if (false) {
  // @ts-expect-error model remains a nested readonly host projection.
  run.model.provider = "fictional";
  // @ts-expect-error model references remain readonly.
  run.model.reference = "fictional:replacement";
  const background = null as unknown as import("@mono-agent/turn/host/types").ProcessJobStartRequest;
  const foreground = null as unknown as import("@mono-agent/turn/host/types").OwnedForegroundProcessRequest;
  // @ts-expect-error background prepared commands are readonly host capabilities.
  background.prepared.command = "fictional";
  // @ts-expect-error foreground prepared cleanup cannot be replaced.
  foreground.prepared.cleanup = async () => {};
  const hostResult = null as unknown as import("@mono-agent/turn/host/types").RuntimeResult;
  // @ts-expect-error structured output must first be narrowed from unknown.
  hostResult.structuredResult.unchecked;
  const core = null as unknown as Awaited<ReturnType<ReturnType<typeof createRuntime>["run"]>>;
  const router = null as unknown as Awaited<ReturnType<ReturnType<typeof createRouterRuntime>["run"]>>;
  core.events?.push({ type: "fixture" });
  core.events?.map((event) => event.type.toLowerCase());
  router.events?.map((event) => event.type.toLowerCase());
  core.runtimeWarnings?.map((warning) => Object.keys(warning));
  // @ts-expect-error public core events cannot lose their type discriminator.
  core.events?.push({});
}

if (false) {
  type Dispatch = Awaited<ReturnType<NonNullable<ReturnType<typeof createRuntime>["prepareNativeDispatch"]>>>;
  const dispatch = null as unknown as Dispatch;
  dispatch.checkHandoffSummary?.({ prepared: { status: "prepared", checkpoints: [], ledger: [], recent: [], older: [], coverage: [] }, outputReserve: 1 });
  type Summary = Extract<Awaited<ReturnType<NonNullable<Dispatch["produceHandoffSummary"]>>>, { status: "ready" }>;
  const summary = null as unknown as Summary;
  summary.usage.legacyField.nested = true;
  summary.status = "ready";
  // @ts-expect-error public summary field arrays remain readonly.
  summary.summary.intent.push("fictional");
  const host = null as unknown as import("@mono-agent/turn/host/types").RuntimeHandoffProducerRequest;
  // @ts-expect-error host checkpoint evidence stays unknown until narrowed.
  host.prepared.checkpoints[0]!.legacyField.nested = true;
}

if (false) {
  // @ts-expect-error open host extensions are unknown, not a supported alias.
  const oldMode: "all" | "one-at-a-time" | undefined = run.piToolParallelismMode;
  void oldMode;
  const core = createRuntime();
  // @ts-expect-error retired scheduling has no packed canonical alias.
  core.run("SYSTEM", { model: run.model, piToolParallelismMode: "all" });
}
