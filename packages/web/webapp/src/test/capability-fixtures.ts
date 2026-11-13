import type { WebCapabilitySetupSnapshot } from "../types";
import displayFixture from "./capability-snapshot.fixture.json";

/** Synthetic statuses; exact production recipe copy, not a parallel catalog.
 * Regenerate: pnpm --filter @mono-agent/app run generate:capability-display-fixture (builds app first)
 * capability-status.test.ts fails if this drifts from the app's real projection.
 */
export const capabilitySnapshot = displayFixture as WebCapabilitySetupSnapshot;
