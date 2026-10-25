import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { OwnerPrivateLockOptions } from "./owner-private-lock.js";

export const AGENT_ROOT_LEASE_MUTATION_GATE = ".mutation-gate.sqlite";

/** One digest function and owner policy for acquisition and the absent-root sweep. */
export function agentRootDigest(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex");
}

export function agentRootLeaseLockOptions(leaseRoot: string, digest: string): OwnerPrivateLockOptions {
  return {
    path: join(leaseRoot, `${digest}.lease`),
    label: "Agent-root lease",
    schemaTag: "mono-agent.agent-root-lease.v1",
    ownerlessGraceMs: 5 * 60_000,
    maxAcquireAttempts: 4,
    mutationGate: { path: join(leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE) },
    // Legacy records remain valid for acquisition, but the sweep skips them.
    validateOwnerFields: (record) => record.rootDigest === digest,
    invalidOwner: "error",
    livenessError: () => "assume-live",
    staleRace: "return",
    stalePath: ({ now, pid, token }) => join(leaseRoot, `.${digest}-${now}-${pid}-${token}.stale`),
    releasedPath: ({ pid, token }) => join(leaseRoot, `.${digest}-${pid}-${token}.released`),
    abandonedPath: ({ pid, token }) => join(leaseRoot, `.${digest}-${pid}-${token}.abandoned`),
  };
}
