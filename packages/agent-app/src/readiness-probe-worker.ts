import { parentPort, workerData } from "node:worker_threads";

import { createMonoRuntime, createPiOAuthApiKeyResolver } from "@mono-agent/runtime-adapter";
import type {
  RuntimeEventLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

const MAX_SAFE_MESSAGE_CHARS = 400;
const TOOL_EVENT_TYPES = new Set([
  "bash",
  "collab_agent_tool_call",
  "command_execution",
  "dynamic_tool_call",
  "file_change",
  "image_generation",
  "image_view",
  "mcp_tool_call",
  "sleep",
  "subagent_activity",
  "tool_call",
  "tool_result",
  "tool_use",
  "web_search",
]);

interface ReadinessWorkerData {
  readonly cwd: string;
  readonly runtime: {
    readonly model: RuntimeModelReference;
    readonly executionMode?: string;
    readonly effort?: string;
    readonly workspace: string;
    readonly artifactDir: string;
    readonly piAuthPath?: string;
  };
}

type WorkerOutput =
  | {
      readonly type: "result";
      readonly hasText: boolean;
      readonly cancelled: boolean;
      readonly failureKind?: string;
      readonly errorMessage?: string;
    }
  | { readonly type: "tool"; readonly action: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "disposed" };

function readWorkerData(value: unknown): ReadinessWorkerData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || !isRecord(record.runtime)) {
    return undefined;
  }
  const runtime = record.runtime;
  if (
    !isRuntimeModelReference(runtime.model)
    || (runtime.executionMode !== undefined && typeof runtime.executionMode !== "string")
    || (runtime.effort !== undefined && typeof runtime.effort !== "string")
    || typeof runtime.workspace !== "string"
    || typeof runtime.artifactDir !== "string"
    || (runtime.piAuthPath !== undefined && typeof runtime.piAuthPath !== "string")
  ) {
    return undefined;
  }
  return {
    cwd: record.cwd,
    runtime: {
      model: runtime.model,
      ...(runtime.executionMode === undefined ? {} : { executionMode: runtime.executionMode }),
      ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
      workspace: runtime.workspace,
      artifactDir: runtime.artifactDir,
      ...(runtime.piAuthPath === undefined ? {} : { piAuthPath: runtime.piAuthPath }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeModelReference(value: unknown): value is RuntimeModelReference {
  if (!isRecord(value) || typeof value.sdk !== "string" || typeof value.model !== "string") {
    return false;
  }
  return (value.provider === undefined || typeof value.provider === "string")
    && (value.reference === undefined || typeof value.reference === "string");
}

function exactEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ));
}

function safeWorkerMessage(
  value: unknown,
  fallback: string,
  additionalSecrets: ReadonlySet<string> = new Set(),
): string {
  let message = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : fallback;

  // Redact every credential-shaped value and every sufficiently distinctive
  // environment value. This happens before IPC, so raw provider errors never
  // cross the worker boundary even when an SDK includes request details.
  const environmentValues = Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string"
        && entry[1].length > 0
        && (/(api.?key|credential|password|secret|token)/iu.test(entry[0]) || entry[1].length >= 4),
    )
    .map(([, environmentValue]) => environmentValue)
    .concat([...additionalSecrets].filter((secret) => secret.length > 0))
    .sort((left, right) => right.length - left.length);
  for (const environmentValue of environmentValues) {
    message = message.replaceAll(environmentValue, "[REDACTED]");
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)(\s*[=:]\s*)([^\s,;]+)/giu,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`,
    )
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/gu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  if (message.length === 0) {
    return fallback;
  }
  return message.length > MAX_SAFE_MESSAGE_CHARS
    ? `${message.slice(0, MAX_SAFE_MESSAGE_CHARS - 1)}…`
    : message;
}

function normalizedEventType(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[./-]+/gu, "_").toLowerCase()
    : "";
}

function toolActionInEvent(event: RuntimeEventLike): string | undefined {
  const eventType = normalizedEventType(event.type);
  if (TOOL_EVENT_TYPES.has(eventType)) {
    return eventType;
  }
  const item = event.item;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const itemType = normalizedEventType((item as Record<string, unknown>).type);
    if (TOOL_EVENT_TYPES.has(itemType)) {
      return itemType;
    }
  }
  const message = event.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }
    const blockType = normalizedEventType((block as Record<string, unknown>).type);
    if (blockType === "tool_use" || blockType === "tool_call" || blockType === "tool_result") {
      return blockType;
    }
  }
  return undefined;
}

function post(message: WorkerOutput): void {
  try {
    parentPort?.postMessage(message);
  } catch {
    // The parent has already completed bounded shutdown.
  }
}

async function run(): Promise<void> {
  const port = parentPort;
  const data = readWorkerData(workerData);
  if (port === null || data === undefined) {
    post({ type: "error", message: "The isolated readiness worker received invalid startup data." });
    return;
  }

  const controller = new AbortController();
  const runtimeSecrets = new Set<string>();
  let runtime: ReturnType<typeof createMonoRuntime> | undefined;
  let disposePromise: Promise<void> | undefined;
  const disposeRuntime = (): Promise<void> => {
    disposePromise ??= Promise.resolve()
      .then(() => runtime?.disposeAllSessions?.())
      .then(() => undefined, () => undefined);
    return disposePromise;
  };
  const abortAndDispose = (): void => {
    controller.abort();
    // A runtime may ignore abort while still honoring explicit session cleanup.
    // Do not wait for run() to settle before giving disposal its bounded chance.
    void disposeRuntime();
  };
  port.on("message", (message: unknown) => {
    if (
      typeof message === "object"
      && message !== null
      && !Array.isArray(message)
      && (message as Record<string, unknown>).type === "abort"
    ) {
      abortAndDispose();
    }
  });

  try {
    const env = exactEnvironment();
    if (controller.signal.aborted) {
      post({ type: "result", hasText: false, cancelled: true });
      return;
    }
    // No fallback chain is supplied: this worker exercises only the validated
    // primary model. All config loading and validation stayed in the parent.
    const piApiKeyResolver = data.runtime.piAuthPath === undefined
      ? undefined
      : createPiOAuthApiKeyResolver({ path: data.runtime.piAuthPath });
    runtime = createMonoRuntime({
      workspace: data.runtime.workspace,
      qaOutputDir: data.runtime.artifactDir,
      ...(piApiKeyResolver === undefined
        ? {}
        : {
            resolvePiApiKey: async (provider: string) => {
              const secret = await piApiKeyResolver(provider);
              if (typeof secret === "string" && secret.length > 0) {
                runtimeSecrets.add(secret);
              }
              return secret;
            },
          }),
    });
    let firstToolAction: string | undefined;
    const runOptions: RuntimeRunOptions = {
      model: data.runtime.model,
      ...(data.runtime.executionMode === undefined ? {} : { executionMode: data.runtime.executionMode }),
      ...(data.runtime.effort === undefined ? {} : { effort: data.runtime.effort }),
      messages: [{ role: "user", content: "Reply with a short readiness acknowledgement." }],
      abortSignal: controller.signal,
      cwd: data.cwd,
      maxTurns: 1,
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      codexNoToolsProbe: true,
      onEvent: (event) => {
        const action = toolActionInEvent(event);
        if (action !== undefined && firstToolAction === undefined) {
          firstToolAction = action;
          post({ type: "tool", action });
          abortAndDispose();
        }
      },
      sessionKeepAlive: false,
      providerEnv: env,
    };
    const result: RuntimeResult = await runtime.run("Reply concisely. Do not use tools.", runOptions);
    for (const event of result.events ?? []) {
      firstToolAction ??= toolActionInEvent(event);
    }
    if (firstToolAction !== undefined) {
      post({ type: "tool", action: firstToolAction });
      return;
    }
    const failureKind = result.failureKind === undefined || result.failureKind === null
      ? undefined
      : safeWorkerMessage(result.failureKind, "provider_failure", runtimeSecrets);
    const errorMessage = result.error === undefined || result.error === null
      ? undefined
      : safeWorkerMessage(result.error, "The selected provider reported an error.", runtimeSecrets);
    post({
      type: "result",
      hasText: (result.text ?? "").trim().length > 0,
      cancelled: result.cancelled === true,
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  } catch (error) {
    post({
      type: "error",
      message: safeWorkerMessage(error, "The isolated readiness worker failed unexpectedly.", runtimeSecrets),
    });
  } finally {
    await disposeRuntime();
    post({ type: "disposed" });
    port.close();
  }
}

await run();
