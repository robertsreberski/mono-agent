import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// HOME deliberately does not override the production account home. Mock the
// account-home module on both test graphs instead, before any app is loaded.
const home = mkdtempSync(join(realpathSync(tmpdir()), "mono-agent-test-home-"));
const previous = process.env.MONO_AGENT_TEST_LEASE_HOME;
process.env.MONO_AGENT_TEST_LEASE_HOME = home;
vi.mock("../host/account-home.js", () => ({ accountHomeDirectory: () => home }));
vi.mock("../../dist/host/account-home.js", () => ({ accountHomeDirectory: () => home }));

afterAll(() => {
  if (previous === undefined) delete process.env.MONO_AGENT_TEST_LEASE_HOME;
  else process.env.MONO_AGENT_TEST_LEASE_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
