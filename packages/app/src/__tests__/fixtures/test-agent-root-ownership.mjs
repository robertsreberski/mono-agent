import { acquireAgentRootOwnership } from "../../../dist/durable-state/agent-root-coordinator.js";

/** Child fixtures cannot inherit Vitest module mocks. Never fall back to the account home. */
export async function acquireTestAgentRootOwnership(root) {
  const homeDir = process.env.MONO_AGENT_TEST_LEASE_HOME;
  if (!homeDir) throw new Error("Child fixture requires an isolated test lease home.");
  // Hold one reference for the child's entire lifetime, including deliberate
  // crash boundaries. The test setup removes this home after its children exit.
  return acquireAgentRootOwnership(root, { homeDir });
}
