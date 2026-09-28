import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  describeTopicResolutionFailure,
  readTelegramTopicDirectoryChat,
  resolveTopicByName,
  telegramTopicListing,
  type TelegramDirectoryChatSnapshot,
} from "./telegram-topic-directory.js";
import { TELEGRAM_SCHEDULE_NAME_MAX_CHARS, TELEGRAM_SCHEDULE_PROMPT_MAX_BYTES } from "./telegram-schedule-service.js";

/**
 * Topic-directory and schedule tools of the app-owned adapter-send MCP child.
 *
 * Topic lookups read the host's directory fresh from disk on every call; the
 * schedule tools only forward to the host schedule service over the
 * interaction bridge with a request-scoped bearer the host issued for this
 * run. Neither ever returns a forum topic id: the model addresses topics by
 * name and receives names, labels and opaque schedule ids.
 */

export interface TelegramTopicDirectoryToolSettings {
  readonly root: string;
  readonly botId: string;
}

export interface TelegramScheduleBridgeSettings {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
}

/** Resolve `topic_name` for a send tool, failing with the known names when it cannot. */
export async function resolveTelegramTopicName(
  directory: TelegramTopicDirectoryToolSettings,
  chatId: string | number,
  topicName: string,
  toolName: string,
): Promise<{ readonly topicId: number; readonly name: string }> {
  const snapshot = await readDirectorySafely(directory, String(chatId), toolName);
  const resolution = resolveTopicByName(snapshot, topicName);
  if (resolution.kind !== "found") {
    throw new Error(describeTopicResolutionFailure(toolName, topicName, resolution, snapshot));
  }
  return { topicId: resolution.topic.topicId, name: resolution.topic.name };
}

async function readDirectorySafely(
  directory: TelegramTopicDirectoryToolSettings,
  chatId: string,
  toolName: string,
): Promise<TelegramDirectoryChatSnapshot> {
  try {
    return await readTelegramTopicDirectoryChat(directory.root, directory.botId, chatId);
  } catch {
    throw new Error(`${toolName}: the Telegram topic directory is unavailable right now; retry shortly.`);
  }
}

export function registerTelegramListTopicsTool(
  server: McpServer,
  directory: TelegramTopicDirectoryToolSettings,
  resolveChat: (requested: string | number | undefined) => string,
): void {
  server.registerTool(
    "TelegramListTopics",
    {
      title: "List known Telegram topics",
      description:
        "List the forum topics of an allowed Telegram chat that the bot has seen, by name and status. The list is incomplete by nature: Telegram cannot enumerate topics, so a topic appears only after the bot has seen a message in it. Use a listed name as topic_name when sending or scheduling. Omit chat_id for the chat this conversation is in.",
      inputSchema: {
        chat_id: z
          .union([z.string().min(1), z.number().int()])
          .optional()
          .describe("Telegram chat id from the adapter allowlist. Defaults to this conversation's chat."),
      },
    },
    async (args) => {
      const chatId = resolveChat(args.chat_id);
      const snapshot = await readDirectorySafely(directory, chatId, "TelegramListTopics");
      const listing = telegramTopicListing(snapshot);
      return {
        content: [{ type: "text", text: JSON.stringify(listing, null, 2) }],
        structuredContent: listing,
      };
    },
  );
}

const SCHEDULE_BRIDGE_TIMEOUT_MS = 10_000;

const destinationSchema = z.object({
  chat_id: z.union([z.string().min(1), z.number().int()]).optional()
    .describe("Allowed Telegram chat id. Defaults to this conversation's chat."),
  topic_name: z.string().min(1).max(256).optional()
    .describe("Forum topic by its name (see TelegramListTopics). Exclusive with main."),
  main: z.literal(true).optional()
    .describe("Post to the chat's main conversation (a forum's General topic)."),
}).strict();

const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: z.string().min(1).max(64).describe("RFC 3339 timestamp with an explicit offset, e.g. 2026-10-01T08:00:00+02:00."),
  }).strict(),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1).max(128).describe("Five cron fields: minute hour day-of-month month day-of-week."),
    timezone: z.string().min(1).max(64).describe("IANA timezone, e.g. Europe/Budapest. Ask the user when unknown."),
  }).strict(),
]);

const DESTINATION_DESCRIPTION =
  "Where results are posted. Omit to use this conversation (this chat, and this topic when you are in one).";

export function registerTelegramScheduleTools(
  server: McpServer,
  bridge: TelegramScheduleBridgeSettings,
  tools: {
    readonly list: boolean;
    readonly create: boolean;
    readonly update: boolean;
    readonly delete: boolean;
  },
  fetchImpl: typeof fetch,
): void {
  const call = async (operation: string, args: unknown, toolName: string, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetchImpl(new URL("/v1/telegram-schedules", bridge.bridgeUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.bridgeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation, args }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SCHEDULE_BRIDGE_TIMEOUT_MS)]),
      });
    } catch {
      throw new Error(`${toolName}: the schedule service is unreachable.`);
    }
    let body: { ok?: unknown; result?: unknown; error?: unknown } = {};
    try {
      body = await response.json() as typeof body;
    } catch {
      // Fall through to the status-based error below.
    }
    if (response.status === 401) {
      throw new Error(`${toolName}: this run is no longer allowed to use schedules.`);
    }
    if (body.ok !== true || typeof body.result !== "object" || body.result === null) {
      const reason = typeof body.error === "string" ? body.error : `schedule service returned HTTP ${String(response.status)}`;
      throw new Error(`${toolName}: ${reason}`);
    }
    const result = body.result as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  };

  if (tools.list) {
    server.registerTool(
      "TelegramListSchedules",
      {
        title: "List Telegram schedules",
        description:
          "List this agent's scheduled Telegram tasks: id, revision, name, prompt, destination, timing, status, next run and the last run's outcome. Use the id and revision to update or delete one.",
        inputSchema: {},
      },
      async (_args, extra) => await call("list", {}, "TelegramListSchedules", extra.signal),
    );
  }
  if (tools.create) {
    server.registerTool(
      "TelegramCreateSchedule",
      {
        title: "Create a Telegram schedule",
        description:
          "Create a durable schedule that later runs an agent turn in a Telegram chat or forum topic and posts its final answer there. The scheduled run sees only the destination conversation's history plus `prompt`, never this conversation, so write a self-contained prompt with every criterion; ask the user first for anything missing (what to check, when, which timezone). A run with nothing worth reporting may answer NOTHING_TO_REPORT and nothing is posted. Missed runs while the agent is offline are skipped, not run late.",
        inputSchema: {
          name: z.string().min(1).max(TELEGRAM_SCHEDULE_NAME_MAX_CHARS).describe("Short human label, e.g. \"Daily flight check\"."),
          prompt: z.string().min(1).describe(
            `Self-contained instructions for each run (max ${String(TELEGRAM_SCHEDULE_PROMPT_MAX_BYTES)} UTF-8 bytes).`,
          ),
          destination: destinationSchema.optional().describe(DESTINATION_DESCRIPTION),
          schedule: scheduleTimingSchema.describe("When to run: a one-off time or a recurring cron expression with timezone."),
        },
      },
      async (args, extra) => await call("create", args, "TelegramCreateSchedule", extra.signal),
    );
  }
  if (tools.update) {
    server.registerTool(
      "TelegramUpdateSchedule",
      {
        title: "Update a Telegram schedule",
        description:
          "Change a schedule: its name, prompt, destination, timing, or pause/resume it with enabled. Pass the revision you last saw as expectedRevision; if it changed, list schedules again. A change cancels a run of the old version that is still in progress.",
        inputSchema: {
          id: z.string().min(1).max(64).describe("Schedule id from TelegramListSchedules."),
          expectedRevision: z.number().int().positive().describe("The schedule's current revision."),
          name: z.string().min(1).max(TELEGRAM_SCHEDULE_NAME_MAX_CHARS).optional(),
          prompt: z.string().min(1).optional(),
          destination: destinationSchema.optional().describe(DESTINATION_DESCRIPTION),
          schedule: scheduleTimingSchema.optional(),
          enabled: z.boolean().optional().describe("false pauses the schedule; true resumes it."),
        },
      },
      async (args, extra) => await call("update", args, "TelegramUpdateSchedule", extra.signal),
    );
  }
  if (tools.delete) {
    server.registerTool(
      "TelegramDeleteSchedule",
      {
        title: "Delete a Telegram schedule",
        description: "Delete a schedule permanently. Pass the revision you last saw as expectedRevision.",
        inputSchema: {
          id: z.string().min(1).max(64).describe("Schedule id from TelegramListSchedules."),
          expectedRevision: z.number().int().positive().describe("The schedule's current revision."),
        },
      },
      async (args, extra) => await call("delete", args, "TelegramDeleteSchedule", extra.signal),
    );
  }
}
