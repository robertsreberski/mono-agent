import type { AdvisorConfig } from "./config.js";
import { abortAdvisorRun, advisorStopReason } from "./cancellation.js";
import type { AdvisorContinuityResolver } from "./continuity.js";
import {
  advisorFailure,
  advisorSuccess,
  continuityIdForSessionKey,
  type AdvisorReviewResponse,
  type ReviewIterationInput,
} from "./protocol.js";
import { buildAdvisorPrompt } from "./prompt.js";
import type { AdvisorRunFactory, AdvisorRunHandle } from "./run.js";
import type { AdvisorStopReason } from "./run.js";

export interface ExecuteReviewIterationOptions {
  readonly input: ReviewIterationInput;
  readonly config: AdvisorConfig;
  readonly runFactory: AdvisorRunFactory;
  readonly abortSignal: AbortSignal;
  readonly shutdownSignal?: AbortSignal;
  readonly continuity?: AdvisorContinuityResolver;
}

export async function executeReviewIteration(
  options: ExecuteReviewIterationOptions,
): Promise<AdvisorReviewResponse> {
  const { model, effort } = requireExecutionSelection(options.config);
  const continuityId = options.continuity?.resolve(options.input.session_key)
    ?? continuityIdForSessionKey(options.input.session_key);
  const cancellation = createCancellationState({
    abortSignal: options.abortSignal,
    ...(options.shutdownSignal === undefined ? {} : { shutdownSignal: options.shutdownSignal }),
    maxRunMs: options.config.maxRunMs,
  });
  if (cancellation.reason !== undefined) {
    cancellation.cleanup();
    return cancellationResponse(cancellation.reason, continuityId, model, effort);
  }
  let run: AdvisorRunHandle;
  try {
    run = await options.runFactory.start({
      continuityId,
      prompt: buildAdvisorPrompt(options.input, options.config),
      model,
      effort,
      ...(options.input.metadata === undefined ? {} : { metadata: options.input.metadata }),
      abortSignal: cancellation.abortSignal,
      maxOutputChars: options.config.maxOutputChars,
    });
    assertRunHandle(run);
  } catch {
    const reason = cancellation.reason;
    cancellation.cleanup();
    if (reason !== undefined) {
      return cancellationResponse(reason, continuityId, model, effort);
    }
    return advisorFailure({
      code: "advisor_run_start_failed",
      message: "The advisor run could not be started.",
      continuityId,
      model,
      effort,
    });
  }

  const lifecycle = new AdvisorRunLifecycle(run);
  if (cancellation.reason !== undefined) {
    const reason = cancellation.reason;
    cancellation.cleanup();
    return await settleCancellation(lifecycle, reason, continuityId, model, effort);
  }

  let response: AdvisorReviewResponse;
  const outcome = await Promise.race([
    run.result.then(
      (result) => ({ kind: "result" as const, result }),
      () => ({ kind: "run_failed" as const }),
    ),
    cancellation.cancelled.then((reason) => ({ kind: "cancelled" as const, reason })),
  ]);
  if (outcome.kind === "cancelled") {
    cancellation.cleanup();
    return await settleCancellation(lifecycle, outcome.reason, continuityId, model, effort);
  }
  cancellation.cleanup();
  if (outcome.kind === "run_failed") {
    response = advisorFailure({
      code: "advisor_run_failed",
      message: "The advisor run failed.",
      continuityId,
      model,
      effort,
    });
  } else {
    const result = outcome.result;
    if (result === null || typeof result !== "object" || typeof result.text !== "string") {
      response = advisorFailure({
        code: "advisor_run_invalid",
        message: "The advisor run returned an invalid result.",
        continuityId,
        model,
        effort,
      });
    } else if (result.text.trim().length === 0) {
      response = advisorFailure({
        code: "advisor_empty_output",
        message: "The advisor run returned no review text.",
        continuityId,
        model,
        effort,
      });
    } else {
      response = advisorSuccess({
        continuityId,
        model,
        effort,
        review: result.text,
        ...(result.truncated === true ? { truncated: true } : {}),
      });
    }
  }

  try {
    await lifecycle.drain();
  } catch {
    return advisorFailure({
      code: "advisor_cleanup_failed",
      message: "The advisor run cleanup did not complete.",
      continuityId,
      model,
      effort,
    });
  }
  return response;
}

class AdvisorRunLifecycle {
  readonly #run: AdvisorRunHandle;
  #stopPromise: Promise<void> | undefined;
  #drainPromise: Promise<void> | undefined;

  constructor(run: AdvisorRunHandle) {
    this.#run = run;
    void run.result.catch(() => undefined);
  }

  stop(reason: AdvisorStopReason): Promise<void> {
    this.#stopPromise ??= Promise.resolve().then(async () => await this.#run.stop(reason));
    return this.#stopPromise;
  }

  drain(): Promise<void> {
    this.#drainPromise ??= Promise.resolve().then(async () => await this.#run.drain());
    return this.#drainPromise;
  }
}

async function settleCancellation(
  lifecycle: AdvisorRunLifecycle,
  reason: AdvisorStopReason,
  continuityId: string,
  model: string,
  effort: NonNullable<AdvisorConfig["effort"]>,
): Promise<AdvisorReviewResponse> {
  let cleanupFailed = false;
  try {
    await lifecycle.stop(reason);
  } catch {
    cleanupFailed = true;
  }
  try {
    await lifecycle.drain();
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    return advisorFailure({
      code: "advisor_cleanup_failed",
      message: "The advisor run cleanup did not complete.",
      continuityId,
      model,
      effort,
    });
  }
  return cancellationResponse(reason, continuityId, model, effort);
}

function cancellationResponse(
  reason: AdvisorStopReason,
  continuityId: string,
  model: string,
  effort: NonNullable<AdvisorConfig["effort"]>,
): AdvisorReviewResponse {
  if (reason === "timeout") {
    return advisorFailure({
      status: "timed_out",
      code: "advisor_timeout",
      message: "The advisor run reached its configured timeout.",
      continuityId,
      model,
      effort,
    });
  }
  if (reason === "server_shutdown") {
    return advisorFailure({
      status: "cancelled",
      code: "advisor_shutdown",
      message: "The advisor server is shutting down.",
      continuityId,
      model,
      effort,
    });
  }
  return advisorFailure({
    status: "cancelled",
    code: "advisor_cancelled",
    message: "The advisor run was cancelled by the client.",
    continuityId,
    model,
    effort,
  });
}

interface CancellationState {
  readonly abortSignal: AbortSignal;
  readonly cancelled: Promise<AdvisorStopReason>;
  readonly reason: AdvisorStopReason | undefined;
  cleanup(): void;
}

function createCancellationState(input: {
  readonly abortSignal: AbortSignal;
  readonly shutdownSignal?: AbortSignal;
  readonly maxRunMs: number;
}): CancellationState {
  const controller = new AbortController();
  let reason: AdvisorStopReason | undefined;
  let resolveCancelled: (reason: AdvisorStopReason) => void = () => {};
  const cancelled = new Promise<AdvisorStopReason>((resolvePromise) => {
    resolveCancelled = resolvePromise;
  });
  const cancel = (next: AdvisorStopReason): void => {
    if (reason !== undefined) return;
    reason = next;
    abortAdvisorRun(controller, next);
    resolveCancelled(next);
  };
  const clientAbort = (): void => cancel(advisorStopReason(input.abortSignal.reason));
  const shutdownAbort = (): void => cancel("server_shutdown");
  if (input.abortSignal.aborted) {
    clientAbort();
  } else {
    input.abortSignal.addEventListener("abort", clientAbort, { once: true });
  }
  if (input.shutdownSignal?.aborted === true) {
    shutdownAbort();
  } else {
    input.shutdownSignal?.addEventListener("abort", shutdownAbort, { once: true });
  }
  const timeout = input.maxRunMs === 0
    ? undefined
    : setTimeout(() => cancel("timeout"), input.maxRunMs);
  timeout?.unref();
  return {
    abortSignal: controller.signal,
    cancelled,
    get reason() {
      return reason;
    },
    cleanup() {
      input.abortSignal.removeEventListener("abort", clientAbort);
      input.shutdownSignal?.removeEventListener("abort", shutdownAbort);
      if (timeout !== undefined) clearTimeout(timeout);
    },
  };
}

function requireExecutionSelection(config: AdvisorConfig): {
  readonly model: string;
  readonly effort: NonNullable<AdvisorConfig["effort"]>;
} {
  if (config.model === undefined || config.effort === undefined) {
    throw new TypeError("Advisor execution requires configured model and effort values.");
  }
  return { model: config.model, effort: config.effort };
}

function assertRunHandle(value: AdvisorRunHandle): void {
  if (value === null
    || typeof value !== "object"
    || !(value.result instanceof Promise)
    || typeof value.stop !== "function"
    || typeof value.drain !== "function") {
    throw new TypeError("Advisor run factory returned an invalid run handle.");
  }
}
