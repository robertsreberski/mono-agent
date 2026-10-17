import { mergeSandboxPolicies, networkPolicyAllowsUrl, prepareSandboxedCommand } from "./index.js";

/**
 * Concrete host enforcement, injected only by host/create-runtime.ts.
 * The JavaScript turn core depends on agent/sandbox-seam.js, not these host
 * implementations. No configured policy means passthrough; a configured policy
 * without an injected implementation fails closed.
 *
 * Host policy is structurally richer than the opaque core SandboxPolicy. These
 * thin adapters keep that explicit boundary without changing policy semantics.
 */
export const monoSandboxImpl = {
  mergePolicies(configured: any, request: any): any {
    return mergeSandboxPolicies(configured, request);
  },
  async prepareCommand(input: { policy?: any; engine?: any; command: any }): Promise<any> {
    return prepareSandboxedCommand(input);
  },
  networkAllowsUrl(policy: any, url: string): boolean {
    return networkPolicyAllowsUrl(policy, url);
  },
};
