// Public host admission gateway to the exact native content digest.
export { digestTurnInput as digestNativeTurnInput } from "../engine/turn-evidence.js";

// Live-input prompt fragment owned by src/runtime/ and consumed by provider
// implementations without importing host queue/controller implementations.

// A host or run `prompts.liveInputGuidance(body)` override, when supplied,
// replaces the default guidance wrapper below; otherwise the default is used.
export function formatLiveInputGuidance(text: string, prompts?: import("../contracts/policy.js").RuntimePromptOverrides | undefined): string {
  if (typeof prompts?.liveInputGuidance === "function") {
    return prompts.liveInputGuidance(String(text || ""));
  }
  return [
    "Live guidance from the user:",
    String(text || ""),
    "",
    "Apply this guidance before continuing. It may correct, narrow, or override your current approach.",
    "Keep satisfying the original task and existing comments except where this live guidance conflicts with them.",
    "When there is a conflict, the newest human live guidance wins. Do not discard the broader task unless the user explicitly asks to replace it.",
  ].join("\n");
}
