// @ts-check

/** @param {{submit(question: {question: string, options?: string[]}): Promise<void>}|null} [controller] */
export function createAskParentTool(controller = null) {
  if (!controller) return null;
  let submitted = false;
  return {
    name: "AskParent", label: "AskParent", executionMode: "sequential",
    description: "Ask your parent agent a question and end this turn. Your parent can reply through AgentSend into this same session. This does not contact the user.",
    parameters: {
      type: "object", additionalProperties: false, required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2000 },
        options: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 200 } },
      },
    },
    /** @param {string} _id @param {{question: string, options?: string[]}} params @param {AbortSignal} [signal] */
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      if (!params || Object.keys(params).some((key) => !["question", "options"].includes(key))
        || typeof params.question !== "string" || !params.question.trim() || params.question.length > 2000) throw new Error("AskParent question must be non-empty and at most 2000 characters.");
      if (params.options !== undefined && (!Array.isArray(params.options) || params.options.length < 2 || params.options.length > 5
        || params.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 200))) throw new Error("AskParent options must contain 2–5 non-empty strings of at most 200 characters.");
      const options = params.options === undefined ? undefined : [...new Set(params.options.map((option) => option.trim()))];
      if (options && options.length < 2) throw new Error("AskParent requires at least two distinct options.");
      const question = { question: params.question.trim(), ...(options === undefined ? {} : { options }) };
      if (submitted) throw new Error("AskParent already submitted a question this turn.");
      submitted = true;
      await controller.submit(question);
      return { content: [{ type: "text", text: `Awaiting parent reply: ${JSON.stringify(question)}` }], details: { tool: "AskParent", question }, terminate: true };
    },
  };
}
