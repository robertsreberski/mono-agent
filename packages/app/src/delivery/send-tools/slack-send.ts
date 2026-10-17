import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_MAX_MESSAGE_CHARS, splitTextForChat } from "@mono-agent/contracts";
import type { SlackChatPostMessageResult, SlackWebApi } from "@mono-agent/channel-slack";
import * as z from "zod/v4";

import { normalizeSlackChannelId } from "./clients.js";
import {
  recordAdapterDeliveryHistory,
  deliveryHistorySummary,
  withDeliveryHistoryWarning,
  type DeliveryHistoryOutcome,
} from "./delivery-history.js";
import { appendPostedMessage } from "../posted-message-index.js";
import type { AdapterSendToolsDeliveryHistory, AdapterSendToolsIndexing, SlackSendToolSettings } from "./types.js";

/**
 * Per-post budget for `SlackSendMessage`. Deliberately the shared substrate
 * budget rather than Slack's 40,000-character truncation ceiling: well below the
 * ceiling Slack silently breaks a long post into several messages of its own
 * and returns only the LAST fragment's `ts`, which would leave the head message
 * absent from the posted-message index and unable to resolve a reply in its
 * thread. Chunking here keeps the boundary — and the indexed ids — ours.
 */
const SLACK_SEND_MESSAGE_MAX_CHARS = DEFAULT_MAX_MESSAGE_CHARS;

export function registerSlackSendTool(
  server: McpServer,
  settings: SlackSendToolSettings,
  client: Pick<SlackWebApi, "chatPostMessage">,
  formatMarkdownForSlack: (text: string) => string,
  indexing?: AdapterSendToolsIndexing,
  deliveryHistory?: AdapterSendToolsDeliveryHistory,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  server.registerTool(
    "SlackSendMessage",
    {
      title: "Send Slack message",
      description: "Send a message to an allowed Slack channel or DM ID using the configured Slack adapter bot token.",
      inputSchema: {
        channel: z.string().min(1).describe("Slack channel or DM ID, e.g. C123456 or D123456."),
        text: z.string().min(1).describe("Message text to send. Defaults to standard Markdown converted to Slack mrkdwn."),
        thread_ts: z.string().min(1).optional().describe("Optional Slack thread timestamp to reply in."),
        mrkdwn: z.boolean().optional().describe("Whether Slack mrkdwn formatting is enabled. Defaults to true; set false to send plain text unchanged."),
        unfurl_links: z.boolean().optional().describe("Whether Slack should unfurl links."),
        unfurl_media: z.boolean().optional().describe("Whether Slack should unfurl media."),
      },
    },
    async (args, extra) => {
      assertSlackChannelAllowed(settings, args.channel);
      const mrkdwn = args.mrkdwn ?? true;
      const text = mrkdwn ? formatMarkdownForSlack(args.text) : args.text;
      const chunks = splitTextForChat(text, SLACK_SEND_MESSAGE_MAX_CHARS);
      const results: SlackChatPostMessageResult[] = [];
      const historyOutcomes: Array<DeliveryHistoryOutcome | undefined> = [];
      for (const chunk of chunks) {
        let result: SlackChatPostMessageResult;
        try {
          result = await client.chatPostMessage(
            {
              channel: args.channel.trim(),
              text: chunk,
              ...(args.thread_ts === undefined ? {} : { thread_ts: args.thread_ts }),
              mrkdwn,
              ...(args.unfurl_links === undefined ? {} : { unfurl_links: args.unfurl_links }),
              ...(args.unfurl_media === undefined ? {} : { unfurl_media: args.unfurl_media }),
            },
            { signal: extra.signal },
          );
        } catch (error) {
          // Chunks before this one are already visible in the channel. Throwing
          // bare would tell the model only "it failed", and the obvious repair —
          // send the whole thing again — would duplicate the confirmed prefix.
          // So report the partial delivery explicitly and let it send only the
          // remainder. (A stable per-chunk client_msg_id would let Slack dedupe a
          // blind retry too; that is a larger contract change and not done here.)
          if (results.length === 0) {
            throw error;
          }
          return slackPartialSendResult(results, chunks, error, deliveryHistorySummary(historyOutcomes));
        }
        results.push(result);
        const historyOutcome = await recordAdapterDeliveryHistory({
          settings: deliveryHistory,
          fetchImpl,
          conversationId: `slack:${result.channel}:${args.thread_ts?.trim() || result.ts}`,
          text: chunk,
          idempotencyKey: `adapter-send:slack:${result.channel}:${result.ts}`,
        });
        historyOutcomes.push(historyOutcome);
        // Link every confirmed posted chunk back to its producing conversation.
        // The history attempt always settles first; an accepted cross-conversation
        // record is therefore durable before the alias appears. A rejected or
        // unreachable best-effort history path remains visible in the tool result
        // but must never regress the existing producer-reply routing contract.
        if (indexing !== undefined) {
          await appendPostedMessage(indexing.indexPath, {
            channelId: result.channel,
            ts: result.ts,
            conversationId: indexing.conversationId,
            // Every chunk of one oversized post is tagged with the first chunk's
            // ts, so the index counts this as ONE claim on the producing
            // conversation. Without it, a split message would look like several
            // independent posts competing for the same producer, and the lookup
            // would decline the alias for all of them.
            groupId: results[0]?.ts ?? result.ts,
          });
        }
      }
      const [firstResult] = results;
      if (firstResult === undefined) {
        throw new Error("SlackSendMessage: no message chunks were produced.");
      }
      const chunkRefs = results.map((result) => ({ channel: result.channel, ts: result.ts }));
      const message =
        results.length === 1
          ? `Sent Slack message to ${firstResult.channel} at ${firstResult.ts}.`
          : `Sent ${String(results.length)} Slack messages to ${firstResult.channel} starting at ${firstResult.ts}.`;
      const history = deliveryHistorySummary(historyOutcomes);
      return {
        content: [{ type: "text", text: withDeliveryHistoryWarning(message, history) }],
        structuredContent:
          results.length === 1
            ? {
                ok: true,
                channel: firstResult.channel,
                ts: firstResult.ts,
                ...(history === undefined ? {} : { history }),
              }
            : {
                ok: true,
                channel: firstResult.channel,
                ts: firstResult.ts,
                chunkCount: results.length,
                chunks: chunkRefs,
                ...(history === undefined ? {} : { history }),
              },
      };
    },
  );
}

/**
 * An oversized `SlackSendMessage` that got part-way through its chunks.
 *
 * `ok: false` with the confirmed chunks named, so the model can see exactly what
 * the channel already shows and resend only the missing tail. Reporting this as a
 * plain throw would invite a full resend and duplicate the visible prefix.
 */
function slackPartialSendResult(
  delivered: readonly SlackChatPostMessageResult[],
  chunks: readonly string[],
  error: unknown,
  history: DeliveryHistoryOutcome | undefined,
): {
  content: [{ type: "text"; text: string }];
  isError: true;
  structuredContent: Record<string, unknown>;
} {
  const first = delivered[0]!;
  const remaining = chunks.length - delivered.length;
  const message = [
    `Partially sent: ${String(delivered.length)} of ${String(chunks.length)} Slack message parts are CONFIRMED in`,
    `${first.channel} starting at ${first.ts}. Part ${String(delivered.length + 1)} failed (${errorText(error)}) with an`,
    "UNKNOWN outcome — Slack may or may not have accepted it before the error.",
    `Never resend the confirmed parts. Check the channel before resending part ${String(delivered.length + 1)};`,
    `at most the last ${String(remaining)} part(s) are missing.`,
  ].join(" ");
  return {
    content: [{ type: "text", text: withDeliveryHistoryWarning(message, history) }],
    isError: true,
    structuredContent: {
      ok: false,
      partial: true,
      channel: first.channel,
      ts: first.ts,
      chunkCount: chunks.length,
      deliveredChunkCount: delivered.length,
      // The failing request is AMBIGUOUS, not known-undelivered: Slack may have
      // accepted it and lost the response. Saying otherwise would invite a
      // resend that duplicates it.
      unconfirmedChunkIndex: delivered.length,
      disposition: "unknown",
      chunks: delivered.map((result) => ({ channel: result.channel, ts: result.ts })),
      ...(history === undefined ? {} : { history }),
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSlackChannelAllowed(settings: SlackSendToolSettings, channel: string): void {
  if (settings.allowAllChannels || settings.allowedChannelIds.includes(normalizeSlackChannelId(channel))) {
    return;
  }
  throw new Error("SlackSendMessage: channel is not allowed by Slack adapter config.");
}
