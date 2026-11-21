import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveGoogleThinkingLevel, usesGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

// Pi's literal overload is for statically known pairs. Dynamic references
// are checked by Pi's lookup and return undefined when there is no chat row.
export const getNativePiModel = getBuiltinModel as (provider: string, id: string) => Model<Api> | undefined;

/**
 * Pi 1.6.0 lists `xhigh` for Gemini 4 Neon, but its Gemini API adapter
 * rejects that mapping before transport. Omit levels the direct Google
 * adapter cannot encode, so Pi's own clamping and our pickers agree. Copilot
 * uses OpenAI Completions, which can send `xhigh` as `reasoning_effort`.
 */
export function withGoogleAdapterThinkingLevels<M extends Model<Api>>(model: M): M {
  if (model.provider !== "google" || model.api !== "google-generative-ai" || !model.reasoning) return model;
  const google = model as Model<"google-generative-ai">;
  if (!usesGoogleThinkingLevel(google)) return model;
  const disabled = getSupportedThinkingLevels(model).filter((level) => {
    if (level === "off") return false;
    try {
      resolveGoogleThinkingLevel(google, level);
      return false;
    } catch {
      return true;
    }
  });
  if (disabled.length === 0) return model;
  const thinkingLevelMap: Partial<Record<(typeof disabled)[number], string | null | undefined>> = Object.assign({}, google.thinkingLevelMap);
  for (const level of disabled) thinkingLevelMap[level] = null;
  return { ...model, thinkingLevelMap };
}
