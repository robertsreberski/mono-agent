import { resolvePiRuntimeModel } from "../providers/pi/models.js";
import { estimateTokens } from "../engine/compaction-kit/compaction.js";
import { estimateFixedOverheadTokens } from "../agent/compaction.js";
import { MIN_ANSWER_TOKENS } from "@earendil-works/pi-ai/api/simple-options";

/** Minimum useful fit, not a promise of full max-output capacity. Unknown models
 * stay eligible; normal resolution/admission owns their actual failure. */
export function fallbackContextFit(modelRef, options, systemPrompt, toolSchemaTokens = 0) {
  let model;
  try { model = options.piResolvedModel ?? resolvePiRuntimeModel(modelRef, options).model; }
  catch { return null; }
  const window = Number(options.compaction?.contextWindowOverride) || Number(model.contextWindow);
  if (!(window > 0)) return null;
  const estimate = (options.messages ?? []).reduce((sum, message) => sum + estimateTokens(message), 0)
    + estimateFixedOverheadTokens({ systemPrompt }).fixedOverheadTokens + Math.max(0, toolSchemaTokens);
  const reserve = 4096 + MIN_ANSWER_TOKENS;
  return { fits: estimate + reserve <= window, contextWindow: window, inputEstimate: estimate, reserveTokens: reserve };
}
