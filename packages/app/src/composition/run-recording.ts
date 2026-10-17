import type { MonoAgentConfig } from "@mono-agent/config";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import type { RunRecorder, RunSummary, RuntimeResultLike } from "@mono-agent/observability";

import type {
  ConfiguredAgentInternalHooks,
  ConfiguredConversationHarnessOptions,
  RecorderCompositionDeps,
  RunArtifactCommitHook,
} from "./configured-agent-options.js";

/**
 * Build a recorder for one run. The JSONL recorder is always built first and is
 * returned unchanged when no artifact hook is configured. The optional artifact
 * hook wraps only its commit boundary.
 */
export function composeRunRecorder(
  deps: RecorderCompositionDeps,
  args: {
    readonly runId: string;
    readonly conversationId: string;
    readonly userInput?: string;
    readonly systemPrompt?: string;
    readonly runKind?: "memory" | "channel";
    readonly memoryOperation?: string;
    readonly isolated?: boolean;
    /** Originating channel/trigger kind, e.g. "tui" | "cron" | "webhook" | "memory". */
    readonly source?: string;
    /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
    readonly sourceDetail?: string;
  },
): RunRecorder {
  const jsonl = withArtifactCommitHook(createJsonlRunRecorder({
    runId: args.runId,
    conversationId: args.conversationId,
    artifactDir: deps.artifactDir,
    ...(args.runKind === "memory" ? { artifactKind: "memory" as const } : {}),
    ...(args.isolated === undefined ? {} : { isolated: args.isolated }),
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.sourceDetail === undefined ? {} : { sourceDetail: args.sourceDetail }),
  }), deps.onRunArtifactCommitted, args);
  return jsonl;
}

/**
 * Notify the app at the exact local-artifact boundary so artifact-derived caches
 * update after JSONL has committed.
 */
function withArtifactCommitHook(
  recorder: RunRecorder,
  onCommitted: RunArtifactCommitHook | undefined,
  args: { readonly runId: string; readonly conversationId: string },
): RunRecorder {
  if (onCommitted === undefined) {
    return recorder;
  }
  let terminalPromise: Promise<RunSummary> | undefined;
  const notify = (phase: "started" | "finished", summary?: RunSummary): void => {
    try {
      // The cache invalidation used by the app is synchronous. Promise.resolve
      // also contains an async implementation without delaying
      // the JSONL pipeline or leaking an unhandled rejection.
      void Promise.resolve(onCommitted({
        phase,
        runId: args.runId,
        conversationId: args.conversationId,
        ...(summary === undefined ? {} : { summary }),
      }))
        .catch(() => undefined);
    } catch {
      // Best-effort host bookkeeping must never alter the recorded run outcome.
    }
  };
  const commitTerminal = (operation: () => Promise<RunSummary>): Promise<RunSummary> => {
    terminalPromise ??= operation().then((summary) => {
      notify("finished", summary);
      return summary;
    });
    return terminalPromise;
  };
  const wrapped: RunRecorder = {
    onEvent(event): void {
      recorder.onEvent(event);
    },
    async prepareFinish(result: RuntimeResultLike): Promise<void> {
      await recorder.prepareFinish?.(result);
    },
    async commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
      return await commitTerminal(async () => recorder.commitFinish === undefined
        ? await recorder.finish(result)
        : await recorder.commitFinish(result));
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      await wrapped.prepareFinish?.(result);
      return await wrapped.commitFinish!(result);
    },
    async fail(error: unknown, context?: { readonly systemPrompt?: string }): Promise<RunSummary> {
      return await commitTerminal(async () => context === undefined
        ? await recorder.fail(error)
        : await recorder.fail(error, context));
    },
  };
  if (recorder.start !== undefined) {
    wrapped.start = async (): Promise<RunSummary> => {
      const summary = await recorder.start!();
      notify("started");
      return summary;
    };
  }
  return wrapped;
}

/** Collect the recorder-composition deps from the host config + harness options. */
export async function recorderCompositionDeps(
  config: MonoAgentConfig,
  options: Pick<ConfiguredConversationHarnessOptions, "observabilityContext">,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<RecorderCompositionDeps> {
  const sourceLabel = options.observabilityContext?.sourceLabel ?? config.agent?.name;
  const observabilityContext = options.observabilityContext === undefined && sourceLabel === undefined
    ? undefined
    : {
        ...options.observabilityContext,
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
      };
  return {
    artifactDir: config.artifacts.dir,
    ...(observabilityContext === undefined ? {} : { observabilityContext }),
    ...(internalHooks.onRunArtifactCommitted === undefined
      ? {}
      : { onRunArtifactCommitted: internalHooks.onRunArtifactCommitted }),
  };
}
