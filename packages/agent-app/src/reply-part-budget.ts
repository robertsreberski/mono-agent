import { MAX_AGENT_REPLY_PARTS, type AgentReplyPart } from "@mono-agent/agent-contracts";

export type ReplyPartBudgetClaim = "accepted" | "duplicate" | "limit";

export interface ReplyPartBudget {
  claim(runId: string, stableIdentity: string): ReplyPartBudgetClaim;
  unclaim(runId: string, stableIdentity: string): void;
  release(runId: string): void;
}

/**
 * One request-scoped count/deduplication budget shared by every rich-part
 * producer composed by agent-app. Part payloads remain owned by their producer;
 * this object carries only stable identities and a bounded count.
 */
export function createReplyPartBudget(maxParts = MAX_AGENT_REPLY_PARTS): ReplyPartBudget {
  if (!Number.isSafeInteger(maxParts) || maxParts < 1) {
    throw new RangeError("reply part maxParts must be a positive safe integer.");
  }
  const identitiesByRun = new Map<string, Set<string>>();
  return {
    claim(runId, stableIdentity) {
      const identities = identitiesByRun.get(runId) ?? new Set<string>();
      if (identities.has(stableIdentity)) return "duplicate";
      if (identities.size >= maxParts) return "limit";
      identities.add(stableIdentity);
      identitiesByRun.set(runId, identities);
      return "accepted";
    },
    unclaim(runId, stableIdentity) {
      const identities = identitiesByRun.get(runId);
      identities?.delete(stableIdentity);
      if (identities?.size === 0) identitiesByRun.delete(runId);
    },
    release(runId) {
      identitiesByRun.delete(runId);
    },
  };
}

/** Preserve first-seen producer order while removing retry duplicates. */
export function mergeReplyParts(
  existing: readonly AgentReplyPart[] | undefined,
  produced: readonly AgentReplyPart[],
): readonly AgentReplyPart[] {
  const merged: AgentReplyPart[] = [];
  const identities = new Set<string>();
  for (const part of [...(existing ?? []), ...produced]) {
    const identity = stableReplyPartIdentity(part);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(part);
    if (merged.length === MAX_AGENT_REPLY_PARTS) break;
  }
  return merged;
}

function stableReplyPartIdentity(part: AgentReplyPart): string {
  if (part.type === "attachment") return `attachment:${part.integrityId}`;
  if (part.type === "mcp_app") {
    return `mcp_app:${part.serverName}:${part.toolName}:${part.resourceUri}:${part.id}`;
  }
  return `failure:${part.id}:${part.code}`;
}
