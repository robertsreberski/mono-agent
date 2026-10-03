// @ts-check

/** Steering offers text to a turn already in progress. It is a host-owned
 * operation, never a new child turn, and never a claim that the child obeyed.
 * @param {import('../../ai/types.js').RuntimeSubagentsOptions|null|undefined} subagents
 * @param {{id: string, steer?: string}} params
 * @param {AbortSignal} [signal]
 */
export async function steerSubagent(subagents, params, signal) {
  let jobId = null;
  /** @param {string} code @param {string} [message] */
  const error = (code, message) => receipt({ code, instanceId: typeof params.id === "string" ? params.id : null, jobId,
    status: "not_applied", applied: false, ...(message === undefined ? {} : { message }) }, true);
  // Bounded independently of the contracts package, which tool files do not
  // import; mirrors AGENT_LIVE_INPUT_MAX_CHARACTERS (agent-contracts).
  if (typeof params.steer !== "string" || !params.steer.trim() || params.steer.length > 8_000) {
    return error("subagent_steer_invalid_request", "steer must be a non-empty string of at most 8000 characters.");
  }
  if (typeof params.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(params.id)) {
    return error("subagent_steer_invalid_id", "id must be a string matching ^[a-z0-9][a-z0-9-]{0,39}$ (1-40 lowercase letters, digits or hyphens, starting with a letter or digit).");
  }
  const unexpected = Object.keys(params).filter((key) => !["id", "steer"].includes(key)).sort();
  if (unexpected.length) return error("subagent_steer_unexpected_parameters", `steer takes only id and steer (unexpected: ${unexpected.join(", ")}).`);
  if (signal?.aborted) throw new Error("tool execution aborted");
  const instances = subagents?.instances;
  const controller = subagents?.backgroundSubagentController;
  if (!instances || !controller?.steer) return error("subagent_steer_unavailable");
  let timer;
  let expired = false;
  // The whole operation is bounded. A timed-out offer is an unknown outcome,
  // never an applied one.
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { expired = true; resolve(error("subagent_steer_unavailable", "the steer offer did not settle in time; its delivery is unknown.")); }, 6_000); });
  const operation = async () => {
    try {
      const record = await instances.get(params.id);
      if (!record || !["queued", "running", "idle", "awaiting_reply"].includes(record.status)) return error("subagent_steer_instance_not_found");
      // A foreground child blocks its parent's own turn, so no parent call can
      // reach it while it runs.
      if (record.activeTurn?.kind === "foreground") return error("subagent_steer_foreground_unsupported", "a foreground turn cannot be steered; only cancelling your own turn stops it.");
      if (!["queued", "running"].includes(record.status) || !record.incarnation || record.activeTurn?.kind !== "detached") {
        return error("subagent_steer_not_running", "steering reaches only a queued or running detached turn; use message to start a new turn.");
      }
      if (expired || signal?.aborted) return error("subagent_steer_unavailable");
      jobId = record.activeTurn.token;
      const proof = await controller.steer({ instanceId: record.id, instanceIncarnation: record.incarnation, turnToken: jobId }, params.steer);
      if (!proof || proof.jobId !== jobId || !["consumed", "offered", "rejected", "unsupported"].includes(proof.delivery)) return error("subagent_steer_unavailable");
      const status = proof.delivery === "consumed" ? "applied" : proof.delivery === "offered" ? "pending" : proof.delivery === "unsupported" ? "unsupported" : "not_applied";
      return receipt({ instanceId: record.id, jobId, status, applied: status === "applied", delivery: proof.delivery,
        ...(proof.reason === undefined ? {} : { reason: proof.reason }) });
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
      return error(["subagent_stale_turn", "subagent_steer_unavailable"].includes(code) ? code : "subagent_steer_unavailable");
    }
  };
  try { return await Promise.race([operation(), timeout]); } finally { clearTimeout(timer); }
}

function receipt(steer, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(steer) }],
    details: { tool: "AgentManage", steer, executed: false } };
}
