// @ts-check
import { stopSubagent } from "./agent-send-stop.js";
import { createAgentTool } from "./agent-tool.js";

/**
 * Continue the stored definition through the same execution, timeout, budget and activity path as Agent.
 * @param {import('../../ai/types.js').RuntimeSubagentsOptions|null|undefined} subagents
 * @param {Parameters<typeof createAgentTool>[1]} [context]
 */
export function createAgentSendTool(subagents, context = {}) {
  if (context.instancesEnabled === false || !(context.persistentExposure ?? Boolean(subagents?.instances)) || !subagents?.run || Number(subagents.depth ?? 0) > 0) return null;
  const instances = subagents.instances;
  const background = instances?.reserve && instances?.releaseReservation && subagents.backgroundSubagentController;
  return {
    name: "AgentSend", label: "AgentSend",
    description: "Continue a persistent subagent by id with its full prior context. Instance ids appear in the Session envelope and Agent results. Use close: true when done. Use stop: true with only id and an optional description (ignored) to cooperatively stop a queued/running detached turn, then send an ordinary message or close only after a resumable receipt. Stop never sends instructions, force-kills, or rolls back external effects." + " Set background: true with a message for detached work; this exact conversation wakes on completion or AskParent. Do not poll or replay." + " Use inspect: true alone for bounded recovery evidence; it executes no provider. After independent verification, a retained-only ack with a message explicitly authorizes one continuation. Lost/unknown continuity requires close/create, never replay.",
    parameters: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
        message: { type: "string", minLength: 1 },
        close: { type: "boolean" },
        stop: { type: "boolean", const: true },
        background: { type: "boolean" },
        description: { type: "string", maxLength: 80 },
        inspect: { type: "boolean" },
        ack: { type: "string", maxLength: 128 },
      },
    },
    /** @param {string} callId @param {{id: string, message?: string, close?: boolean, stop?: boolean, description?: string, background?: boolean, inspect?: boolean, ack?: string}} params @param {AbortSignal} [signal] */
    async execute(callId, params, signal) {
      if (Object.hasOwn(params, "stop")) return stopSubagent(subagents, params, signal);
      if (!instances) throw new Error("Error: persistent subagent instances are unavailable in this conversation.");
      if (signal?.aborted) throw new Error("tool execution aborted");
      if (params.inspect !== undefined && typeof params.inspect !== "boolean") throw new Error("Error: inspect must be a boolean.");
      if (params.inspect === true) {
        if ([params.message, params.close, params.background, params.ack, params.description].some((value) => value !== undefined)) throw new Error("Error: inspect must be used alone with id.");
        if (!instances.inspect) throw new Error("Error: subagent recovery inspection is unavailable.");
        const recovery = await instances.inspect(params.id, context.recoveryAccess);
        return { content: [{ type: "text", text: JSON.stringify(recovery) }], details: { tool: "AgentSend", recovery, executed: false } };
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
          details: { tool: "AgentSend", subagent: { name: record.name, status: "ok", instance: { id: closed.id, turns: closed.turns, status: closed.status } } } };
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
          return { content: [{ type: "text", text: code }], details: { tool: "AgentSend", recovery: { code }, executed: false } };
        }
        throw error;
      }
    },
  };
}
