// Unified-only execution. Historical observation readers retain old-name attribution.
import { fail } from "./continuity-observation-input.mjs";
export function e2HistorySurface(surface = "unified") {
  if (surface !== "unified") fail("E2_ARGUMENTS_INVALID");
  return "unified";
}
export const historySurfaceBinding = surface => { e2HistorySurface(surface); return {historySurface:"unified"}; };
export const historyToolName = surface => { e2HistorySurface(surface); return "History"; };
export const historyServerName = surface => { e2HistorySurface(surface); return "mono-agent-history"; };
export const historyConfig = surface => { e2HistorySurface(surface); return {}; };
export const historyArguments = (surface, args, scope = "said") => { e2HistorySurface(surface); return {scope,...args}; };
export function assertHistorySurfaceBinding(registration, value) {
  if (registration.replayArm === "history-ab") { if (Object.hasOwn(registration,"historySurface") || (Object.hasOwn(value,"historySurface") && value.historySurface !== "unified")) fail("e2_authorization_binding_mismatch"); return; }
  if (registration.historySurface !== "unified" || value.historySurface !== "unified") fail("e2_authorization_binding_mismatch");
}
// Keep scope attribution explicit: tools/runs are not conversation-text lookups.
export function historyCallScope(name, args) {
  if (["ConversationHistory", "conversation_history", "mcp__mono-agent-conversation-history__ConversationHistory"].includes(name)) return "said";
  if (["SessionHistory", "session_history", "mcp__mono-agent-session-history__SessionHistory"].includes(name)) return "tools";
  if (["RunHistory", "run_history", "mcp__mono-agent-run-history__RunHistory"].includes(name)) return "runs";
  if (["History", "mcp__mono-agent-history__History"].includes(name) && ["said", "tools", "runs"].includes(args?.scope)) return args.scope;
  return undefined;
}
/**
 * A/B lookup attribution: `historyCallScope`, or `"invalid"` for a unified
 * History call whose scope fails the shipping scope check (missing, typo'd or
 * not one of said/tools/runs). The failed attempt is still a lookup attempt.
 */
export function e2AbLookupScope(name, args) {
  return historyCallScope(name, args) ?? (["History", "mcp__mono-agent-history__History"].includes(name) ? "invalid" : undefined);
}

// Current execution allowlist. Older versions are historical evidence only.
export const LOOKUP_TOOL_ALLOWLIST_V3 = Object.freeze({version:"v3",tools:Object.freeze(["History"])});
export const lookupToolAllowlist = surface => { e2HistorySurface(surface); return LOOKUP_TOOL_ALLOWLIST_V3; };

export const E2_AB_REPLAY_ARM = "history-ab";
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
// Historical arm A used the split surface. Current arms differ only in the
// compact (B) or directive (C) History description.
export const E2_AB_ARM_SURFACES = freeze({
  B: { historySurface: "unified", descriptionVariant: "compact" },
  C: { historySurface: "unified", descriptionVariant: "directive" },
});
export const E2_AB_ARMS = Object.freeze(Object.keys(E2_AB_ARM_SURFACES));
export function e2AbArm(letter) {
  if (!E2_AB_ARMS.includes(letter)) fail("E2_AB_BINDING_INVALID");
  return letter;
}
export const e2AbSlotArm = letter => `${E2_AB_REPLAY_ARM}-${e2AbArm(letter)}`;
/** The arm letter of an A/B phase slot, or undefined for every legacy slot arm. */
export const e2AbArmOfSlot = arm => typeof arm === "string" && /^history-ab-[A-Z]$/u.test(arm) && E2_AB_ARMS.includes(arm.slice(-1)) ? arm.slice(-1) : undefined;
/** Per-slot History surface: an A/B slot uses its arm, every other slot the registration. */
export function e2SlotHistorySurface(registration, slot) {
  const arm = e2AbArmOfSlot(slot?.arm);
  if (arm === undefined) { if (registration?.historySurface !== "unified") fail("e2_registration_invalid"); return "unified"; }
  if (registration?.replayArm !== E2_AB_REPLAY_ARM || slot.kind !== "replay" || Object.hasOwn(registration, "historySurface")) fail("e2_registration_invalid");
  return E2_AB_ARM_SURFACES[arm].historySurface;
}
