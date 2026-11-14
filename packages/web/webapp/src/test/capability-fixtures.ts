import type { WebCapabilitySetupSnapshot, WebCapabilityActionsSnapshot } from "../types";
import actionsFixture from "./capability-actions.fixture.json";
import displayFixture from "./capability-snapshot.fixture.json";

/** Synthetic statuses; exact production recipe copy, not a parallel catalog.
 * Regenerate: pnpm --filter @mono-agent/app run generate:capability-display-fixture (builds app first)
 * capability-status.test.ts fails if this drifts from the app's real projection.
 */
export const capabilitySnapshot = displayFixture as WebCapabilitySetupSnapshot;

export const capabilityActions = actionsFixture as WebCapabilityActionsSnapshot;

/** Separate flow: an existing valid enabled job, but operator controls are not saved yet. */
export const eligibleCronSnapshot: WebCapabilitySetupSnapshot = {
  ...capabilitySnapshot,
  cards: capabilitySnapshot.cards.map((card) => card.id === "channel:cron" ? { ...card, status: "ok", evidence: card.evidence.map((item) => ({ ...item, status: "ok" })) } : card),
};
export const eligibleCronActions: WebCapabilityActionsSnapshot = {
  ...capabilityActions,
  actions: capabilityActions.actions.map((action) => action.id === "cron-controls" ? { ...action, available: true, reason: "eligible" } : action),
};
