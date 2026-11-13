import type { WebCapabilitySetupSnapshot } from "../types";
import displayFixture from "./capability-snapshot.fixture.json";

/** Synthetic statuses; exact production recipe copy, not a parallel catalog.
 * Regenerate: pnpm --filter @mono-agent/app run generate:capability-display-fixture (builds app first)
 * capability-status.test.ts fails if this drifts from the app's real projection.
 */
export const capabilitySnapshot = displayFixture as WebCapabilitySetupSnapshot;

export const capabilityActions = {
  version: 1 as const, process: capabilitySnapshot.process,
  actions: [
    { id: "memory-lite" as const, available: true, active: true, reason: "already-configured" as const },
    { id: "cron-controls" as const, available: true, active: false, reason: "eligible" as const },
  ],
};
