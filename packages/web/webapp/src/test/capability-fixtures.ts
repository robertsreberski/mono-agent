import type { WebCapabilitySetupSnapshot } from "../types";
import displayFixture from "./capability-snapshot.fixture.json";

/** Synthetic statuses; exact production recipe copy, not a parallel catalog.
 * Regenerate after app build: node packages/app/scripts/generate-capability-display-fixture.mjs
 * capability-status.test.ts fails if this drifts from the app's real projection.
 */
export const capabilitySnapshot = displayFixture as WebCapabilitySetupSnapshot;
