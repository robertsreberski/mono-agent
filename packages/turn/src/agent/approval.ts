// Approval manager: gates individual tool calls behind an optional host
// callback that can approve, deny, or "always approve" (session-scoped
// allowlist). Adapted from zeroclaw's ApprovalManager pattern.
//
// Runtime bridges opt in by passing `onToolApprovalRequest`; the Claude SDK and
// Pi bridges do not install this manager when that callback is absent. A host
// that calls `createApprovalManager` directly without a callback gets these
// low-level per-tier defaults:
//   low risk    → auto-approve
//   medium risk → auto-approve (no host means "don't pause")
//   high risk   → deny (fail closed)
//
// Risk tiers are configured per tool via `riskTiersByTool`; tools missing from
// the map use `defaultRiskTier` ("medium"). A `Bash` tier of "high" is the
// canonical example.
//
// The manager emits structured events through the supplied `onEvent`:
//   - tool_approval_pending  — before calling the host
//   - tool_approval_granted  — host approved (or session allowlist hit)
//   - tool_approval_denied   — host denied, timed out, or host threw
//
// Approval responses from the host should look like
//   { decision: "approve" | "deny" | "always", reason?: string }
// "always" approves this call and adds the tool to the session allowlist.
// Anything else is treated as `tier === "high" ? deny : approve`.

import { randomUUID } from "node:crypto";

const APPROVAL_DECISIONS = Object.freeze(["approve", "deny", "always"]);
const RISK_TIERS = Object.freeze(["low", "medium", "high"]);

const DEFAULT_TIMEOUT_MS = 60_000;

export function createApprovalManager({
  onToolApprovalRequest = null,
  defaultRiskTier = "medium",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent = () => {},
  riskTiersByTool = {},
  alwaysAllowTools = [],
  autoApproveLowRisk = true,
}: { onToolApprovalRequest?: any; defaultRiskTier?: string; timeoutMs?: number; onEvent?: (event: any) => void; riskTiersByTool?: any; alwaysAllowTools?: any; autoApproveLowRisk?: boolean; } | undefined = {}): {
  request: (toolCall?: {
    toolName?: unknown;
    name?: unknown;
    toolUseId?: unknown;
    id?: unknown;
    requestId?: unknown;
    input?: unknown;
    arguments?: unknown;
    model?: unknown;
  }) => Promise<{
    requestId: {};
    riskTier: string;
    decision: string;
    reason: string | null;
  }>;
  riskTierFor: (toolName: string) => string;
  sessionAllowlist: () => Set<any>;
  isAlwaysAllowed: (toolName: unknown) => boolean;
} {
  const sessionAllowlist = new Set(normaliseList(alwaysAllowTools));
  const normalisedTiersByTool = Object.fromEntries(
    Object.entries(riskTiersByTool || {})
      .filter(([, v]) => RISK_TIERS.includes(v as string))
      .map(([k, v]) => [String(k), v as string]),
  );
  const normalisedDefault = RISK_TIERS.includes(defaultRiskTier) ? defaultRiskTier : "medium";
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  function riskTierFor(toolName: string) {
    return normalisedTiersByTool[toolName] || normalisedDefault;
  }

  function emit(event: Record<string, unknown>) {
    try { onEvent(event); } catch { /* host emit errors must not escape */ }
  }

  async function request(toolCall: { toolName?: unknown; name?: unknown; toolUseId?: unknown; id?: unknown; requestId?: unknown; input?: unknown; arguments?: unknown; model?: unknown } = {}) {
    const toolName = String(toolCall.toolName || toolCall.name || "");
    const toolUseId = toolCall.toolUseId || toolCall.id || null;
    const tier = riskTierFor(toolName);
    const requestId = toolCall.requestId || randomUUID();

    if (tier === "low" && autoApproveLowRisk !== false) {
      emitGrant({ requestId, toolName, toolUseId, tier, decision: "approve", reason: "low_risk" });
      return { decision: "approve", reason: "low_risk", requestId, riskTier: tier };
    }

    if (sessionAllowlist.has(toolName)) {
      emitGrant({ requestId, toolName, toolUseId, tier, decision: "approve", reason: "session_allowed" });
      return { decision: "approve", reason: "session_allowed", requestId, riskTier: tier };
    }

    if (typeof onToolApprovalRequest !== "function") {
      if (tier === "high") {
        emitDenial({ requestId, toolName, toolUseId, tier, reason: "no_host_callback_for_high_risk" });
        return { decision: "deny", reason: "no_host_callback_for_high_risk", requestId, riskTier: tier };
      }
      emitGrant({
        requestId,
        toolName,
        toolUseId,
        tier,
        decision: "approve",
        reason: "no_host_callback_medium_auto_approve",
      });
      return { decision: "approve", reason: "no_host_callback_medium_auto_approve", requestId, riskTier: tier };
    }

    const argumentsSummary = redactSecrets(stringifyShort(toolCall.input || toolCall.arguments || {}));
    const payload = {
      requestId,
      toolName,
      toolUseId,
      argumentsSummary,
      riskTier: tier,
      model: toolCall.model || null,
    };

    emit({ type: "tool_approval_pending", ...payload });

    let response;
    let timedOut = false;
    let timer;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => onToolApprovalRequest(payload)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("approval_timeout"));
          }, timeout);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      const reason = timedOut || (err as { message?: unknown } | null | undefined)?.message === "approval_timeout"
        ? "approval_timeout"
        : `host_error:${redactSecrets(stringifyShort((err as { message?: unknown } | null | undefined)?.message || err))}`;
      emitDenial({ requestId, toolName, toolUseId, tier, reason });
      return { decision: "deny", reason, requestId, riskTier: tier };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const normalised = normaliseResponse(response, tier);
    if (normalised.decision === "always") {
      sessionAllowlist.add(toolName);
    }
    if (normalised.decision === "deny") {
      emitDenial({ requestId, toolName, toolUseId, tier, reason: normalised.reason });
    } else {
      emitGrant({
        requestId,
        toolName,
        toolUseId,
        tier,
        decision: normalised.decision,
        reason: normalised.reason,
      });
    }
    return { ...normalised, requestId, riskTier: tier };
  }

  function emitDenial({ requestId = null, toolName, toolUseId = null, tier, reason }: ApprovalNotice) {
    emit({
      type: "tool_approval_denied",
      requestId,
      toolName,
      toolUseId,
      decision: "deny",
      reason,
      riskTier: tier,
    });
  }

  function emitGrant({ requestId, toolName, toolUseId = null, tier, decision, reason }: ApprovalNotice & { decision: string }) {
    emit({
      type: "tool_approval_granted",
      requestId,
      toolName,
      toolUseId,
      decision,
      reason,
      riskTier: tier,
    });
  }

  return {
    request,
    riskTierFor,
    sessionAllowlist: () => new Set(sessionAllowlist),
    isAlwaysAllowed: (toolName: unknown) => sessionAllowlist.has(String(toolName)),
  };
}

function normaliseResponse(response: unknown, tier: string) {
  if (!response || typeof response !== "object") {
    const fallback = tier === "high" ? "deny" : "approve";
    return { decision: fallback, reason: "invalid_host_response" };
  }
  const decision = APPROVAL_DECISIONS.includes((response as { decision?: string }).decision!)
    ? (response as { decision?: string }).decision!
    : (tier === "high" ? "deny" : "approve");
  return {
    decision,
    reason: typeof (response as { reason?: string }).reason === "string"
      ? redactSecrets((response as { reason?: string }).reason).slice(0, 2000)
      : null,
  };
}

function normaliseList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))]
    : [];
}

function stringifyShort(value: unknown) {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(value || "");
  }
}

// Redact obvious secrets in argument summaries before we hand them to the
// host's approval UI. Hosts that need raw arguments should read them from
// their own audit log, not from the approval payload.
function redactSecrets(text: unknown) {
  const s = String(text || "");
  return s
    .replace(/\b(?:sk|pk)[-_][A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"');
}

// Wrap a list of Pi-bridge-style tools so each `execute(toolCallId: string, params: unknown, signal?: AbortSignal)`
// first checks the approval manager. Denied calls throw with a structured
// message so the agent receives a tool_result.is_error and can adapt.
export function wrapToolsWithApprovalGate(tools: unknown, approvalManager: ReturnType<typeof createApprovalManager> | null | undefined, { model = null }: { model?: unknown } = {}): any[] {
  const list = Array.isArray(tools) ? tools : [];
  if (!approvalManager) return list;
  return list.map((tool) => {
    if (!tool || typeof tool.execute !== "function") return tool;
    const originalExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
        const decision = await approvalManager.request({
          toolName: tool.name,
          toolUseId: toolCallId,
          input: params,
          model,
        });
        if (decision.decision === "deny") {
          throw new Error(`Tool call denied (${decision.reason || "no reason"}): ${tool.name}`);
        }
        return originalExecute(toolCallId, params, signal);
      },
    };
  });
}

type ApprovalNotice = { requestId?: unknown; toolName: string; toolUseId?: unknown; tier: string; reason: unknown };
