import type { AdvisorConfig } from "./config.js";
import {
  advisorFailure,
  advisorSuccess,
  continuityIdForSessionKey,
  type AdvisorReviewResponse,
  type ReviewIterationInput,
} from "./protocol.js";
import { buildAdvisorPrompt } from "./prompt.js";
import type { AdvisorRunFactory, AdvisorRunHandle } from "./run.js";

export interface ExecuteReviewIterationOptions {
  readonly input: ReviewIterationInput;
  readonly config: AdvisorConfig;
  readonly runFactory: AdvisorRunFactory;
  readonly abortSignal: AbortSignal;
}

export async function executeReviewIteration(
  options: ExecuteReviewIterationOptions,
): Promise<AdvisorReviewResponse> {
  const { model, effort } = requireExecutionSelection(options.config);
  const continuityId = continuityIdForSessionKey(options.input.session_key);
  let run: AdvisorRunHandle;
  try {
    run = await options.runFactory.start({
      continuityId,
      prompt: buildAdvisorPrompt(options.input, options.config),
      model,
      effort,
      ...(options.input.metadata === undefined ? {} : { metadata: options.input.metadata }),
      abortSignal: options.abortSignal,
      maxOutputChars: options.config.maxOutputChars,
    });
    assertRunHandle(run);
  } catch {
    return advisorFailure({
      code: "advisor_run_start_failed",
      message: "The advisor run could not be started.",
      continuityId,
      model,
      effort,
    });
  }

  let response: AdvisorReviewResponse;
  try {
    const result = await run.result;
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
  } catch {
    response = advisorFailure({
      code: "advisor_run_failed",
      message: "The advisor run failed.",
      continuityId,
      model,
      effort,
    });
  }

  try {
    await run.drain();
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
