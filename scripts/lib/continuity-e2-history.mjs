// Explicit split is execution-equivalent but remains digest-bound JSON. Builders
// omit it to preserve legacy raw and canonical registration digests.
// Shared offline selector. Omitted/split leave legacy request and artifact shapes intact.
import { fail } from "./continuity-observation-input.mjs";
export function e2HistorySurface(surface = "split") {
  if (!["split", "unified"].includes(surface)) fail("E2_ARGUMENTS_INVALID");
  return surface;
}
export const historySurfaceBinding = surface => e2HistorySurface(surface) === "unified" ? { historySurface: "unified" } : {};
export const historyToolName = surface => e2HistorySurface(surface) === "unified" ? "History" : "ConversationHistory";
export const historyServerName = surface => e2HistorySurface(surface) === "unified" ? "mono-agent-history" : "mono-agent-conversation-history";
export const historyConfig = surface => e2HistorySurface(surface) === "unified" ? { history: { unified: true } } : {};
export const historyArguments = (surface, args, scope = "said") => e2HistorySurface(surface) === "unified" ? { scope, ...args } : args;
export function assertHistorySurfaceBinding(registration, value) {
  if (e2HistorySurface(registration.historySurface) !== e2HistorySurface(value.historySurface)) fail("e2_authorization_binding_mismatch");
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

// Both the lookup safety guard and paid E2 config guard consume this selector.
export const LOOKUP_TOOL_ALLOWLIST_V1 = Object.freeze({ version: "v1", tools: Object.freeze(["ConversationHistory"]) });
export const LOOKUP_TOOL_ALLOWLIST_V2 = Object.freeze({ version: "v2", tools: Object.freeze(["ConversationHistory", "History"]) });
export const lookupToolAllowlist = surface => e2HistorySurface(surface) === "unified" ? LOOKUP_TOOL_ALLOWLIST_V2 : LOOKUP_TOOL_ALLOWLIST_V1;

// Closed History A/B arm table (names and surfaces only, no I/O). The A/B mode is
// explicit opt-in (`replayArm: "history-ab"`); omitting it keeps every existing
// E2 registration, schedule and policy byte-identical.
export const E2_AB_REPLAY_ARM = "history-ab";
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
// A: split ConversationHistory with the default soul. B/C: unified History with
// the compact or directive description. Nothing else differs between arms.
export const E2_AB_ARM_SURFACES = freeze({
  A: { historySurface: "split" },
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
  if (arm === undefined) return registration?.historySurface;
  if (registration?.replayArm !== E2_AB_REPLAY_ARM || slot.kind !== "replay" || Object.hasOwn(registration, "historySurface")) fail("e2_registration_invalid");
  return E2_AB_ARM_SURFACES[arm].historySurface;
}
