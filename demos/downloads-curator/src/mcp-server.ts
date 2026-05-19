#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  applyDownloadsProposal,
  createDownloadsProposal,
  DownloadsCuratorToolError,
  isDownloadsCategory,
  listDownloads,
  type CreateDownloadsProposalInput,
  type DownloadsProposalActionInput,
  type DownloadsToolContext,
} from "./downloads-tools.js";

const TOOL_DEFINITIONS = [
  {
    name: "downloads_list",
    description: "List top-level entries in the configured Downloads folder with file metadata and cleanup hints.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "downloads_create_proposal",
    description: "Create a pending Downloads cleanup proposal. This does not move or trash files.",
    inputSchema: {
      type: "object",
      required: ["rationale", "actions"],
      properties: {
        rationale: { type: "string" },
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["kind", "source", "reason"],
            properties: {
              kind: { type: "string", enum: ["move", "trash"] },
              source: { type: "string" },
              targetCategory: {
                type: "string",
                enum: ["Documents", "Images", "Media", "Archives", "Installers", "Code", "Other"],
              },
              reason: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "downloads_apply_proposal",
    description: "Apply explicitly approved Downloads cleanup proposal actions.",
    inputSchema: {
      type: "object",
      required: ["proposalId", "approvalPhrase", "actionIds"],
      properties: {
        proposalId: { type: "string" },
        approvalPhrase: { type: "string" },
        actionIds: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export async function startDownloadsCuratorMcpServer(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const context = contextFromEnv(env);
  const server = new Server(
    { name: "downloads-curator", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(context, request.params.name, request.params.arguments);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = formatToolError(error);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

async function callTool(
  context: DownloadsToolContext,
  name: string,
  args: unknown,
): Promise<unknown> {
  if (name === "downloads_list") {
    return await listDownloads(context);
  }
  if (name === "downloads_create_proposal") {
    return await createDownloadsProposal(context, parseCreateProposalArgs(args));
  }
  if (name === "downloads_apply_proposal") {
    return await applyDownloadsProposal(context, parseApplyProposalArgs(args));
  }
  throw new DownloadsCuratorToolError("unknown_tool", `Unknown Downloads curator tool: ${name}`);
}

function contextFromEnv(env: Record<string, string | undefined>): DownloadsToolContext {
  const downloadsRoot = env.DOWNLOADS_CURATOR_ROOT;
  if (downloadsRoot === undefined || downloadsRoot.trim().length === 0) {
    throw new Error("DOWNLOADS_CURATOR_ROOT is required.");
  }
  return {
    downloadsRoot,
    ...(env.DOWNLOADS_CURATOR_STATE_DIR === undefined ? {} : { stateDir: env.DOWNLOADS_CURATOR_STATE_DIR }),
    ...(env.DOWNLOADS_CURATOR_TRASH_DIR === undefined ? {} : { trashDir: env.DOWNLOADS_CURATOR_TRASH_DIR }),
    ...(env.DOWNLOADS_CURATOR_CURRENT_USER_MESSAGE === undefined
      ? {}
      : { currentUserMessage: env.DOWNLOADS_CURATOR_CURRENT_USER_MESSAGE }),
  };
}

function parseCreateProposalArgs(args: unknown): CreateDownloadsProposalInput {
  const record = asRecord(args, "arguments");
  const actions: DownloadsProposalActionInput[] = asArray(record.actions, "actions").map((action) => {
    const actionRecord = asRecord(action, "action");
    const kind = asString(actionRecord.kind, "action.kind");
    if (kind !== "move" && kind !== "trash") {
      throw new DownloadsCuratorToolError("invalid_input", "action.kind must be move or trash.");
    }
    if (kind === "move") {
      const targetCategory = asString(actionRecord.targetCategory, "action.targetCategory");
      if (!isDownloadsCategory(targetCategory)) {
        throw new DownloadsCuratorToolError("invalid_input", "action.targetCategory is not supported.");
      }
      return {
        kind: "move",
        source: asString(actionRecord.source, "action.source"),
        targetCategory,
        reason: asString(actionRecord.reason, "action.reason"),
      };
    }
    return {
      kind: "trash",
      source: asString(actionRecord.source, "action.source"),
      reason: asString(actionRecord.reason, "action.reason"),
    };
  });
  return {
    rationale: asString(record.rationale, "rationale"),
    actions,
  };
}

function parseApplyProposalArgs(args: unknown): {
  readonly proposalId: string;
  readonly approvalPhrase: string;
  readonly actionIds: readonly string[];
} {
  const record = asRecord(args, "arguments");
  return {
    proposalId: asString(record.proposalId, "proposalId"),
    approvalPhrase: asString(record.approvalPhrase, "approvalPhrase"),
    actionIds: asArray(record.actionIds, "actionIds").map((value) => asString(value, "actionId")),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DownloadsCuratorToolError("invalid_input", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DownloadsCuratorToolError("invalid_input", `${label} must be an array.`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DownloadsCuratorToolError("invalid_input", `${label} must be a non-empty string.`);
  }
  return value;
}

function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, "/"))) {
  void startDownloadsCuratorMcpServer().catch((error: unknown) => {
    process.stderr.write(`${formatToolError(error)}\n`);
    process.exit(1);
  });
}
