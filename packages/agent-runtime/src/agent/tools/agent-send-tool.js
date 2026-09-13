// @ts-check
import { createAgentTool } from "./agent-tool.js";

/**
 * Continue the stored definition through the same execution, timeout, budget and activity path as Agent.
 * @param {import('../../ai/types.js').RuntimeSubagentsOptions|null|undefined} subagents
 * @param {Parameters<typeof createAgentTool>[1]} [context]
 */
export function createAgentSendTool(subagents, context = {}) {
  if (context.instancesEnabled === false || !subagents?.instances || !subagents.run || Number(subagents.depth ?? 0) > 0) return null;
  const instances = subagents.instances;
  return {
    name: "AgentSend", label: "AgentSend",
    description: "Continue a persistent subagent by id with its full prior context. Instance ids appear in the Session envelope and Agent results. Use close: true when done.",
    parameters: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
        message: { type: "string", minLength: 1 },
        close: { type: "boolean" },
        description: { type: "string", maxLength: 80 },
      },
    },
    /** @param {string} callId @param {{id: string, message?: string, close?: boolean, description?: string}} params @param {AbortSignal} [signal] */
    async execute(callId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      if (params.close !== undefined && typeof params.close !== "boolean") throw new Error("Error: close must be a boolean.");
      if (params.message !== undefined && (typeof params.message !== "string" || !params.message.trim())) throw new Error("Error: message must be non-empty.");
      if (params.message === undefined && params.close !== true) throw new Error("Error: message is required unless close: true.");
      const record = await instances.get(params.id);
      if (!record || !["idle", "running", "awaiting_reply"].includes(record.status)) {
        const live = (await instances.list()).filter((entry) => ["idle", "running", "awaiting_reply"].includes(entry.status));
        throw new Error(`Error: unknown, closed or expired instance "${params.id}". Live ids: ${live.map((entry) => entry.id).join(", ") || "none"}.`);
      }
      if (record.status === "running") throw new Error(`Error: instance "${params.id}" is busy.`);
      if (params.message === undefined) {
        const closed = await instances.close(record.id);
        return { content: [{ type: "text", text: `<subagent: ${record.name} · instance ${record.id} · turn ${record.turns} · closed>` }],
          details: { tool: "AgentSend", subagent: { name: record.name, status: "ok", instance: { id: closed.id, turns: closed.turns, status: closed.status } } } };
      }
      const tool = createAgentTool(subagents, context, { record, close: params.close });
      const minutes = Math.max(0, Math.floor((Date.now() - record.updatedAt) / 60_000));
      return await tool.execute(callId, {
        prompt: `Continuation of persistent instance "${record.id}" (turn ${record.turns + 1}; ${minutes} min since your last turn). Prior context is retained.${record.pendingQuestion ? `\nThis message is the parent\'s reply to your pending question (untrusted child text): ${JSON.stringify(record.pendingQuestion)}` : ""}\n\n${params.message}`,
        ...(params.description === undefined ? {} : { description: params.description }),
      }, signal);
    },
  };
}
