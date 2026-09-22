// @ts-check

/** Stop is a host-owned operation, not a new child turn. Never accept job ids from tool input.
 * @param {import('../../ai/types.js').RuntimeSubagentsOptions|null|undefined} subagents
 * @param {{id: string, stop?: boolean, description?: string}} params
 * @param {AbortSignal} [signal]
 */
export async function stopSubagent(subagents, params, signal) {
  let jobId = null;
  /** @type {boolean|"unknown"} */
  let stopRequested = false;
  /** @param {string} code @param {string} [message] */
  const error = (code, message) => receipt({ code, instanceId: typeof params.id === "string" ? params.id : null, jobId, stopRequested,
    ...(message === undefined ? {} : { message }) }, true);
  if (params.stop !== true) return error("subagent_stop_not_requested", "stop must be exactly true.");
  if (typeof params.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(params.id)) {
    return error("subagent_stop_invalid_id", "id must be a string matching ^[a-z0-9][a-z0-9-]{0,39}$ (1-40 lowercase letters, digits or hyphens, starting with a letter or digit).");
  }
  if (params.description !== undefined && (typeof params.description !== "string" || params.description.length > 80)) {
    return error("subagent_stop_invalid_request", "description must be a string of at most 80 characters.");
  }
  const unexpected = Object.keys(params).filter((key) => !["id", "stop", "description"].includes(key)).sort();
  if (unexpected.length) return error("subagent_stop_unexpected_parameters", `stop takes only id and optional description (unexpected: ${unexpected.join(", ")}).`);
  if (signal?.aborted) throw new Error("tool execution aborted");
  const instances = subagents?.instances;
  const controller = subagents?.backgroundSubagentController;
  if (!instances || !controller?.stop) return error("subagent_stop_unavailable");
  let timer;
  let expired = false;
  // The whole operation, including storage, is bounded. A timed-out write is
  // uncertain, not cancellation acceptance. Its captured token cannot stop a successor.
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { expired = true; resolve(error("subagent_stop_unavailable")); }, 6_000); });
  const operation = async () => {
    try {
      const record = await instances.get(params.id);
      if (!record || !["queued", "running", "idle", "awaiting_reply"].includes(record.status)) return error("subagent_stop_instance_not_found");
      const blocked = (value) => value.recovery || value.recoveryBlocked || value.activeTurn;
      if (!["queued", "running"].includes(record.status)) {
        if (blocked(record)) return error("subagent_stop_recovery_required");
        return receipt({ instanceId: record.id, jobId: null, status: "already_idle", instanceStatus: record.status,
          turns: record.turns, disposition: record.lastStatus ?? null, stopRequested: false, childStillBusy: false, resumable: true });
      }
      if (record.activeTurn?.kind === "foreground") return error("subagent_stop_foreground_unsupported");
      if (!record.incarnation || record.activeTurn?.kind !== "detached") return error("subagent_stop_unavailable");
      if (expired || signal?.aborted) return error("subagent_stop_unavailable");
      jobId = record.activeTurn.token;
      stopRequested = "unknown";
      const proof = await controller.stop({ instanceId: record.id, instanceIncarnation: record.incarnation, turnToken: jobId });
      if (proof.jobId !== jobId || typeof proof.stopRequested !== "boolean" || typeof proof.childStillBusy !== "boolean"
        || typeof proof.resumable !== "boolean" || !(proof.disposition === null || ["ok", "awaiting_reply", "failed", "timeout", "cancelled", "empty", "interrupted", "busy"].includes(proof.disposition))) return error("subagent_stop_unavailable");
      stopRequested = proof.stopRequested;
      const current = await instances.get(record.id);
      if (!current || current.incarnation !== record.incarnation || (current.activeTurn && current.activeTurn.token !== jobId)
        || (!current.activeTurn && current.settledTurnToken !== jobId) || current.turns > record.turns + 1) return error("subagent_stale_turn");
      if (!proof.childStillBusy && (!proof.resumable || blocked(current))) return error("subagent_stop_recovery_required");
      if (proof.childStillBusy && (!stopRequested || !["queued", "running"].includes(current.status))) return error("subagent_stop_unavailable");
      if (!proof.childStillBusy && !["idle", "awaiting_reply"].includes(current.status)) return error("subagent_stale_turn");
      return receipt({ instanceId: current.id, jobId, status: proof.childStillBusy ? "stop_requested" : "stopped",
        instanceStatus: current.status, turns: current.turns, disposition: proof.disposition, stopRequested,
        childStillBusy: proof.childStillBusy, resumable: !proof.childStillBusy });
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      if (cause && typeof cause === "object" && "stopRequested" in cause
        && [true, false, "unknown"].includes(cause.stopRequested)) stopRequested = /** @type {boolean|"unknown"} */ (cause.stopRequested);
      return error(["subagent_stale_turn", "subagent_stop_unavailable"].includes(code) ? code : "subagent_stop_unavailable");
    }
  };
  try { return await Promise.race([operation(), timeout]); } finally { clearTimeout(timer); }
}

function receipt(stop, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(stop) }],
    details: { tool: "AgentManage", stop, executed: false } };
}
