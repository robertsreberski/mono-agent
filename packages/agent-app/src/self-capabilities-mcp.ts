import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  applySelfCron,
  applySelfSkill,
  proposeSelfCron,
  proposeSelfSkill,
} from "./self-capabilities.js";
import type { SelfCapabilitiesSettings } from "./self-capabilities.js";
import type { SelfCronInput, SelfSkillInput } from "./self-capabilities.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const nonBlank = z.string().min(1).refine((value: string) => value.trim().length > 0, "must not be empty or whitespace-only");
const skillSchema = {
  name: nonBlank.describe("Path-safe skill name or short title. It is normalized to a lowercase slug."),
  description: nonBlank.describe("One-paragraph description used by the skill index."),
  instructions: nonBlank.describe("The SKILL.md instructions the agent should follow when the skill is selected."),
  title: z.string().optional().describe("Optional Markdown H1 title. Defaults to a title-cased skill slug."),
  activate: z.boolean().optional().describe("Whether to add the skill to context.selectedSkills. Defaults to true."),
};
const skillWriteSchema = {
  ...skillSchema,
  confirmationToken: nonBlank.describe("Operator-supplied token required for persistent self-capability writes."),
};
const cronSchema = {
  id: nonBlank.describe("Path-safe cron job id. It is normalized to a lowercase slug and used as the file name."),
  expression: nonBlank.describe("Five-field cron expression, for example 0 8 * * *."),
  prompt: nonBlank.describe("Markdown prompt body to send to the agent on each scheduled tick."),
  timezone: z.string().optional().describe("IANA timezone. Defaults to UTC."),
  conversationId: z.string().optional().describe("Optional conversation id for memory/history continuity."),
  enabled: z.boolean().optional().describe("Whether the job should be enabled. Defaults to true."),
};
const cronWriteSchema = {
  ...cronSchema,
  confirmationToken: nonBlank.describe("Operator-supplied token required for persistent self-capability writes."),
};

export function createSelfCapabilitiesMcpServer(settings: SelfCapabilitiesSettings): McpServer {
  const server = new McpServer({ name: "mono-agent-self-capabilities", version: "0.3.0" });

  server.registerTool(
    "self_skill_propose",
    {
      title: "Propose a local skill",
      description: "Preview the files and config changes for a local skill. Use this when the user has not explicitly confirmed a write.",
      inputSchema: skillSchema,
    },
    async (args) => result(await proposeSelfSkill(settings, normalizeSkillArgs(args))),
  );

  server.registerTool(
    "self_cron_propose",
    {
      title: "Propose a cron job",
      description: "Preview the markdown cron job and config changes. Use this when the user has not explicitly confirmed a write.",
      inputSchema: cronSchema,
    },
    async (args) => result(await proposeSelfCron(settings, normalizeCronArgs(args))),
  );

  if (settings.mode === "apply" && settings.confirmationToken !== undefined) {
    server.registerTool(
      "self_skill_create",
      {
        title: "Create a local skill",
        description: "Create a local SKILL.md, update config when requested, write an audit record, and request app reload. Requires the operator-provided confirmation token.",
        inputSchema: skillWriteSchema,
      },
      async (args) => result(await applySelfSkill(settings, normalizeSkillWriteArgs(settings, args))),
    );

    server.registerTool(
      "self_cron_create",
      {
        title: "Create a cron job",
        description: "Create a markdown cron job, write an audit record, and request app reload. Requires the operator-provided confirmation token.",
        inputSchema: cronWriteSchema,
      },
      async (args) => result(await applySelfCron(settings, normalizeCronWriteArgs(settings, args))),
    );
  }

  return server;
}

function normalizeSkillArgs(args: {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly title?: string | undefined;
  readonly activate?: boolean | undefined;
}): SelfSkillInput {
  return {
    name: args.name,
    description: args.description,
    instructions: args.instructions,
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.activate === undefined ? {} : { activate: args.activate }),
  };
}

function normalizeSkillWriteArgs(
  settings: SelfCapabilitiesSettings,
  args: Parameters<typeof normalizeSkillArgs>[0] & { readonly confirmationToken: string },
): SelfSkillInput {
  assertConfirmationToken(settings, args.confirmationToken);
  return normalizeSkillArgs(args);
}

function normalizeCronArgs(args: {
  readonly id: string;
  readonly expression: string;
  readonly prompt: string;
  readonly timezone?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly enabled?: boolean | undefined;
}): SelfCronInput {
  return {
    id: args.id,
    expression: args.expression,
    prompt: args.prompt,
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
  };
}

function normalizeCronWriteArgs(
  settings: SelfCapabilitiesSettings,
  args: Parameters<typeof normalizeCronArgs>[0] & { readonly confirmationToken: string },
): SelfCronInput {
  assertConfirmationToken(settings, args.confirmationToken);
  return normalizeCronArgs(args);
}

function assertConfirmationToken(settings: SelfCapabilitiesSettings, value: string): void {
  if (settings.confirmationToken === undefined || value !== settings.confirmationToken) {
    throw new Error("Invalid self-capability confirmation token.");
  }
}

function result(payload: unknown): ToolResult {
  const structured = isRecord(payload) ? payload : { value: payload };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
