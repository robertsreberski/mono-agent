// @ts-check
import { steerSubagent } from "./agent-manage-steer.js";
import { stopSubagent } from "./agent-manage-stop.js";
import { createAgentTool } from "./agent-tool.js";

/**
 * Continue the stored definition through the same execution, timeout, budget and activity path as Agent.
 * @param {import('../../ai/types.js').RuntimeSubagentsOptions|null|undefined} subagents
 * @param {Parameters<typeof createAgentTool>[1]} [context]
 */
export function createAgentManageTool(subagents, context = {}) {
  if (context.instancesEnabled === false || !(context.persistentExposure ?? Boolean(subagents?.instances)) || !subagents?.run || Number(subagents.depth ?? 0) > 0) return null;
  const instances = subagents.instances;
  const background = instances?.reserve && instances?.releaseReservation && subagents.backgroundSubagentController;
  return {
    name: "AgentManage", label: "AgentManage",
    description: "Manage a persistent subagent instance created by Agent with persist: true — continue it, run it detached, stop a detached turn, inspect its recovery state, or close it. Instance ids appear in Agent results and the Session envelope. One mode per call:"
      + "\n- Continue: {id, message} runs one more turn with the instance's full prior context and returns its answer. Add background: true to run it detached — this exact conversation wakes when that turn completes, fails, is interrupted or the child asks through AskParent. Add close: true to close the instance after a successful turn."
      + "\n- Close: {id, close: true} alone closes an instance that is not queued or running, and runs no model."
      + "\n- Stop: {id, stop: true} alone cooperatively stops a queued or running DETACHED turn (a foreground turn cannot be stopped this way; an optional description is accepted and ignored). It sends no instructions, does not force-kill and does not undo external effects. Read the receipt: resumable: true permits a later message or close; stop_requested keeps both blocked until the child actually settles."
      + "\n- Steer: {id, steer: \"<text>\"} alone offers text to a DETACHED turn already in progress, the way live input reaches a running conversation. It starts no turn and forces no answer: read the receipt (applied / pending / not_applied / unsupported). A foreground turn cannot be reached, and an idle instance needs message."
      + "\n- Inspect: {id, inspect: true} alone returns bounded recovery evidence and runs no model."
      + "\n- Ack: {id, ack, message} authorizes exactly one continuation of an instance whose retained recovery evidence you have read; only 'retained' continuity can be acknowledged, and recovering a detached job also requires background: true. Lost or unknown continuity cannot be acknowledged — close that instance and create a new one carrying the context it needs."
      + "\nA queued or running instance rejects message and close; stop it, steer it, or wait for its receipt. A delivery timeout is an unknown outcome: inspect rather than re-sending. The Session envelope reports which of these modes are currently admitted.",
    parameters: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "Instance id from the Agent result or the Session envelope." },
        message: { type: "string", minLength: 1, description: "Next instruction or brief for the child; required to continue, to run detached and with ack." },
        close: { type: "boolean", description: "Close the instance: alone, or after this turn succeeds." },
        stop: { type: "boolean", const: true, description: "Cooperatively stop the instance's detached turn; use alone with id." },
        steer: { type: "string", minLength: 1, maxLength: 8000, description: "Text offered to the instance's in-progress detached turn; use alone with id." },
        background: { type: "boolean", description: "Run this continuation detached and wake this conversation when it settles; requires message." },
        description: { type: "string", maxLength: 80, description: "Short label for the job card (at most 80 characters); accepted and ignored by stop." },
        inspect: { type: "boolean", description: "Return recovery evidence only, running no model; use alone with id." },
        ack: { type: "string", maxLength: 128, description: "Acknowledgement token from the inspect evidence; authorizes one continuation and requires message." },
      },
    },
    /** @param {string} callId @param {{id: string, message?: string, close?: boolean, stop?: boolean, steer?: string, description?: string, background?: boolean, inspect?: boolean, ack?: string}} params @param {AbortSignal} [signal] */
    async execute(callId, params, signal) {
      if (Object.hasOwn(params, "steer")) return steerSubagent(subagents, params, signal);
      if (Object.hasOwn(params, "stop")) return stopSubagent(subagents, params, signal);
      if (!instances) throw new Error("Error: persistent subagent instances are unavailable in this conversation.");
      if (signal?.aborted) throw new Error("tool execution aborted");
      if (params.inspect !== undefined && typeof params.inspect !== "boolean") throw new Error("Error: inspect must be a boolean.");
      if (params.inspect === true) {
        if ([params.message, params.close, params.background, params.ack, params.description].some((value) => value !== undefined)) throw new Error("Error: inspect must be used alone with id.");
        if (!instances.inspect) throw new Error("Error: subagent recovery inspection is unavailable.");
        const recovery = await instances.inspect(params.id, context.recoveryAccess);
        return { content: [{ type: "text", text: JSON.stringify(recovery) }], details: { tool: "AgentManage", recovery, executed: false } };
      }
      if (params.ack !== undefined && (typeof params.ack !== "string" || !params.ack || params.ack.length > 128 || params.message === undefined || !instances.checkAcknowledgement)) throw new Error("Error: ack requires a recovery-capable instance and a message.");
      const acknowledgement = params.ack === undefined ? undefined : { ack: params.ack, message: params.message,
        ...(params.background === undefined ? {} : { background: params.background }), ...(params.close === undefined ? {} : { close: params.close }),
        ...(params.description === undefined ? {} : { description: params.description }) };
      try {
      // Deduplicated acknowledgements are checked before the ordinary busy gate.
      if (acknowledgement) await instances.checkAcknowledgement(params.id, acknowledgement, context.recoveryAccess);
      if (params.background !== undefined && typeof params.background !== "boolean") throw new Error("Error: background must be a boolean.");
      if (params.background === true && !background) throw new Error("Error: background subagents are unavailable in this conversation.");
      if (params.background === true && params.message === undefined) throw new Error("Error: background requires a message; close-only stays synchronous.");
      if (params.close !== undefined && typeof params.close !== "boolean") throw new Error("Error: close must be a boolean.");
      if (params.message !== undefined && (typeof params.message !== "string" || !params.message.trim())) throw new Error("Error: message must be non-empty.");
      if (params.message === undefined && params.close !== true) throw new Error("Error: message is required unless close: true.");
      const record = await instances.get(params.id);
      if (!record || !["queued", "idle", "running", "awaiting_reply"].includes(record.status)) {
        const live = (await instances.list()).filter((entry) => ["queued", "idle", "running", "awaiting_reply"].includes(entry.status));
        throw new Error(`Error: unknown, closed or expired instance "${params.id}". Live ids: ${live.map((entry) => entry.id).join(", ") || "none"}.`);
      }
      if (["queued", "running"].includes(record.status)) throw new Error(`Error: instance "${params.id}" is busy.`);
      if (params.message === undefined) {
        const closed = context.recoveryAccess === undefined ? await instances.close(record.id) : await instances.close(record.id, context.recoveryAccess);
        return { content: [{ type: "text", text: `<subagent: ${record.name} · instance ${record.id} · turn ${record.turns} · closed>` }],
          details: { tool: "AgentManage", subagent: { name: record.name, status: "ok", instance: { id: closed.id, turns: closed.turns, status: closed.status } } } };
      }
      const tool = createAgentTool(subagents, context, { record, close: params.close, ...(acknowledgement ? { acknowledgement } : {}) });
      const minutes = Math.max(0, Math.floor((Date.now() - record.updatedAt) / 60_000));
      return await tool.execute(callId, {
        ...(params.background === undefined ? {} : { background: params.background }),
        prompt: `Continuation of persistent instance "${record.id}" (turn ${record.turns + 1}; ${minutes} min since your last turn). Prior context is retained.${record.pendingQuestion ? `\nThis message is the parent\'s reply to your pending question (untrusted child text): ${JSON.stringify(record.pendingQuestion)}` : ""}\n\n${params.message}`,
        ...(params.description === undefined ? {} : { description: params.description }),
      }, signal);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (["subagent_recovery_already_consumed", "subagent_recovery_ack_conflict", "subagent_recovery_ack_stale", "subagent_recovery_ack_invalid", "subagent_recovery_not_retained", "subagent_recovery_background_required", "subagent_recovery_policy_denied", "subagent_recovery_policy_unavailable"].includes(code)) {
          return { content: [{ type: "text", text: code }], details: { tool: "AgentManage", recovery: { code }, executed: false } };
        }
        throw error;
      }
    },
  };
}
