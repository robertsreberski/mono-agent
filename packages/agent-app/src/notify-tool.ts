import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import type { MonoAgentAppLogger } from "./channels.js";
import type { NotifyDeliveryResult } from "./proactive-notify.js";

/**
 * In-process MCP server that exposes the proactive-notification tools to the agent.
 *
 * Unlike `memory_recall`/the adapter send tools (stdio children that re-derive
 * everything from config/disk), notification delivery has to run a real turn on a
 * destination channel's LIVE session, so the handler must reach the app's running
 * channel registry — which only exists in this process. We therefore host the
 * tools over loopback HTTP (the one MCP transport the runtime's client supports
 * for an in-process server) and close over app-supplied delivery/discovery hooks.
 *
 * Two tools, both intended for proactive cron/webhook turns (the runtime extension
 * only injects this server for those):
 *  - `list_notify_destinations` — discover the conversations the agent may notify
 *    (answers "how do I get a conversationId?" when there is no triggering payload).
 *  - `notify_conversation` — deliver a message as a real turn into one of them.
 */
export const NOTIFY_TOOLS_MCP_SERVER_NAME = "mono-agent-notify";

/** A conversation the agent may proactively notify, surfaced to the model for discovery. */
export interface NotifyToolDestination {
  /** Destination conversationId to pass to `notify_conversation`, e.g. `telegram:42`. */
  readonly conversationId: string;
  /** Owning channel id (telegram/slack). */
  readonly channelId: string;
  /** ISO timestamp of the most recent turn on this conversation, if known. */
  readonly lastSeen?: string;
  /** True when this is an allowlisted destination the agent has not yet conversed with. */
  readonly fromAllowlist?: boolean;
}

export interface NotifyToolsDeps {
  /** Deliver `text` as a real turn into `conversationId` (allowlist-enforced by the owning channel). */
  readonly deliver: (conversationId: string, text: string) => Promise<NotifyDeliveryResult>;
  /** The conversations the agent may notify right now (seen + single-allowlist destinations). */
  readonly listDestinations: () => Promise<readonly NotifyToolDestination[]>;
  readonly logger?: MonoAgentAppLogger | undefined;
}

export interface NotifyToolsServer {
  /** Loopback URL the runtime's MCP client connects to (`http://127.0.0.1:<port>/mcp`). */
  readonly url: string;
  /** Bearer token required on every request. */
  readonly token: string;
  close(): Promise<void>;
}

const MCP_PATH = "/mcp";

/**
 * Start the in-process notify MCP server on an ephemeral loopback port. Stateless:
 * each request gets a fresh `McpServer`+transport (the tools are pure request/response),
 * which sidesteps session bookkeeping and concurrent-trigger races.
 */
export async function startNotifyToolsServer(deps: NotifyToolsDeps): Promise<NotifyToolsServer> {
  const token = randomBytes(24).toString("hex");
  const expectedAuth = `Bearer ${token}`;

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, expectedAuth, deps);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new Error("notify tools server: failed to bind a loopback port.");
  }
  const url = `http://127.0.0.1:${address.port}${MCP_PATH}`;

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedAuth: string,
  deps: NotifyToolsDeps,
): Promise<void> {
  if (!isAuthorized(req, expectedAuth)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (req.url?.split("?", 1)[0] !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  // Stateless: only POST carries JSON-RPC. The single tool round-trips are
  // request/response, so reject the optional GET/DELETE session streams.
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const server = buildMcpServer(deps);
  // Stateless: omitting sessionIdGenerator runs the transport without session
  // tracking, so a fresh server+transport per request is the correct pattern and
  // concurrent triggers never share state.
  const transport = new StreamableHTTPServerTransport({});
  // Idempotent: with HTTP keep-alive the response can `finish` without firing
  // `close`, so bind both and guard against a double-close leaking nothing.
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    void transport.close();
    void server.close();
  };
  res.on("close", cleanup);
  res.on("finish", cleanup);
  try {
    // The transport implements the SDK Transport interface at runtime; the cast
    // bridges an exactOptionalPropertyTypes mismatch in the SDK's own typings.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res);
  } catch (error) {
    deps.logger?.error?.("notify tools server: request failed.", { reason: reasonOf(error) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
}

function isAuthorized(req: IncomingMessage, expectedAuth: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const a = Buffer.from(header);
  const b = Buffer.from(expectedAuth);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildMcpServer(deps: NotifyToolsDeps): McpServer {
  const server = new McpServer({ name: "agent-notify-tools", version: "0.1.0" });

  server.registerTool(
    "list_notify_destinations",
    {
      title: "List notification destinations",
      description:
        "List the conversations you can proactively deliver a message to with notify_conversation. " +
        "Use this when you have no triggering conversationId in hand (e.g. a scheduled/cron run) to " +
        "discover where to reach the user. Each entry's `conversationId` is what notify_conversation " +
        "expects — read its description for how delivery works (the destination turn's reply is what is sent).",
      inputSchema: {},
    },
    async () => {
      const destinations = await deps.listDestinations();
      const lines = destinations.length === 0
        ? ["(no known destinations yet — the agent has not handled any push-channel conversation and no single allowlisted destination is configured)"]
        : destinations.map((d) => `- ${d.conversationId}${d.lastSeen === undefined ? "" : ` (last active ${d.lastSeen})`}${d.fromAllowlist === true ? " (allowlisted, not yet used)" : ""}`);
      return {
        content: [{ type: "text", text: ["Conversations you can notify:", ...lines].join("\n") }],
        structuredContent: { destinations },
      };
    },
  );

  server.registerTool(
    "notify_conversation",
    {
      title: "Notify a conversation",
      description:
        "Proactively deliver a message into a conversation you are not currently handling. The message " +
        "runs as a real turn on that conversation's own session and THAT TURN'S REPLY is what the user " +
        "receives (so the user sees it natively and the conversation remembers it). Use this to follow up " +
        "from a cron job or an inbound webhook callback.\n\n" +
        "How `text` is delivered (read carefully — this is the #1 mistake):\n" +
        "- `text` is the stimulus the destination conversation acts on; it is NOT posted verbatim. The " +
        "destination agent reads `text` and composes the user-facing reply with its own context, and that " +
        "reply is delivered automatically.\n" +
        "- To deliver pre-composed or exact content (e.g. a digest), phrase `text` as an explicit reply " +
        "instruction, e.g.: \"Reply with the text below exactly as written, adding nothing, and do not call " +
        "any tools — your reply is delivered automatically:\\n\\n<your content>\".\n" +
        "- The destination must NOT call its own send tools (e.g. slack_send_message) — its reply is already " +
        "delivered, so sending again posts the message twice.\n\n" +
        "How to choose `conversationId`:\n" +
        "- Webhook/async callback: pass the `conversationId` carried in the triggering request payload.\n" +
        "- Otherwise (e.g. a scheduled run): call list_notify_destinations first and pick from it.\n\n" +
        "Delivery is bounded by the channel allowlist and may return delivered:false (e.g. unknown/disallowed " +
        "id, channel offline). The call blocks until the destination turn replies, so keep that turn to a single " +
        "reply — a turn that re-scans, recalls, or hunts for a send tool is slow and can hit the request timeout. " +
        "If you receive delivered:false, do not assume it was also delivered some other way.",
      inputSchema: {
        conversationId: z
          .string()
          .min(1)
          .describe("Destination conversationId, e.g. telegram:42 or slack:C123 (or slack:C123:1718.99 for a thread)."),
        text: z
          .string()
          .min(1)
          .describe(
            "What to deliver. The destination conversation runs this as a turn and its reply is delivered; " +
              "to deliver exact content, phrase this as a reply-verbatim, no-tools instruction (see the tool description).",
          ),
      },
    },
    async (args) => {
      const result = await deps.deliver(args.conversationId, args.text);
      const summary = result.delivered
        ? `Delivered to ${args.conversationId}.`
        : `Not delivered to ${args.conversationId}${result.reason === undefined ? "" : `: ${result.reason}`}.`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { delivered: result.delivered, ...(result.reason === undefined ? {} : { reason: result.reason }) },
      };
    },
  );

  return server;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
