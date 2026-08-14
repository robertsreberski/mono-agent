import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AdvisorConfig } from "./config.js";
import type { AdvisorContinuityResolver } from "./continuity.js";
import { executeReviewIteration } from "./execution.js";
import {
  advisorToolResult,
  createAdvisorOutputSchema,
  createReviewIterationInputSchema,
  REVIEW_ITERATION_TOOL_NAME,
} from "./protocol.js";
import type { AdvisorRunFactory } from "./run.js";

export interface CreateAdvisorMcpServerOptions {
  readonly config: AdvisorConfig;
  readonly runFactory: AdvisorRunFactory;
  readonly shutdownSignal?: AbortSignal;
  readonly continuity?: AdvisorContinuityResolver;
}

export function createAdvisorMcpServer(options: CreateAdvisorMcpServerOptions): McpServer {
  if (options.config.model === undefined || options.config.effort === undefined) {
    throw new TypeError("Advisor MCP requires explicit model and effort configuration.");
  }
  const server = new McpServer({ name: "mono-agent-advisor", version: "0.19.1" });
  server.registerTool(
    REVIEW_ITERATION_TOOL_NAME,
    {
      title: "Review one implementation iteration",
      description: "Run one bounded advisory responder turn over an untrusted intent, patch, and verification payload. The tool does not claim a separate isolated agent or filesystem access.",
      inputSchema: createReviewIterationInputSchema(options.config),
      outputSchema: createAdvisorOutputSchema(options.config),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => advisorToolResult(await executeReviewIteration({
      input: {
        session_key: input.session_key,
        intent: input.intent,
        patch: input.patch,
        ...(input.verification === undefined ? {} : { verification: input.verification }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      config: options.config,
      runFactory: options.runFactory,
      abortSignal: extra.signal,
      ...(options.shutdownSignal === undefined ? {} : { shutdownSignal: options.shutdownSignal }),
      ...(options.continuity === undefined ? {} : { continuity: options.continuity }),
    }), options.config),
  );
  return server;
}
