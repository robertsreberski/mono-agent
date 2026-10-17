import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AskUserToolSettings } from "./types.js";

/** Keep cancellation responsive even when the loopback bridge is wedged. */
const ASK_BRIDGE_CLEANUP_TIMEOUT_MS = 1_000;

/** Long-poll wait per bridge request; the overall wait is bounded server-side by the ask's timeout. */
const ASK_USER_POLL_WAIT_MS = 20_000;

export function registerAskUserTool(
  server: McpServer,
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
): void {
  server.registerTool(
    "AskUser",
    {
      title: "Ask the user and wait",
      description:
        "Ask the user 1–5 related questions and WAIT for their answers in the current conversation.\n"
        + "Ask whenever a missing decision would change what you build, where you send it, or what you irreversibly touch — before doing the work, not after. A guess that is cheap to reverse is fine; a guess about scope, destination, data you delete or money you spend is not. Ask when the request has two readings that lead to materially different deliverables, when a required input is absent and cannot be derived from the conversation, files or one cheap tool call, or when you are about to assume authority you were not given. Do not ask what the conversation or its attachments already answer, and do not re-ask for approval of work already authorized. One good question early costs less than a wrong deliverable.\n"
        + "Each question must offer 2–3 concise options with descriptions; the UI also permits a custom reply, so options are suggestions, not a closed set. Use multiSelect only when several choices may be combined. Put long decision context or a draft in message — one call carrying several related questions beats several rounds. A second concurrent AskUser call fails. "
        + "The current host timeout policy controls expiry. Keep waiting until the user answers, cancels, or the wait expires; on expiry finish gracefully with partial answers and state assumptions.",
      inputSchema: {
        message: z.string().min(1).max(4_096).optional().describe("Optional context or draft shown above the questions."),
        questions: z.array(z.object({
          header: z.string().min(1).max(12).describe("Short section label, at most 12 characters."),
          question: z.string().min(1).max(1_000).describe("The decision or information needed."),
          options: z.array(z.object({
            label: z.string().min(1).max(75).describe("Concise selectable answer."),
            description: z.string().min(1).max(300).describe("What choosing this option means."),
          })).min(2).max(3),
          multiSelect: z.boolean().optional().describe("Allow selecting more than one proposed answer before Done."),
        })).min(1).max(5),
      },
    },
    async (args, extra) => {
      if (!settings.producerConversationId || !settings.interactionConversationId || !settings.bridgeUrl || !settings.bridgeToken) {
        return { isError: true, content: [{ type: "text" as const, text: "AskUser is unavailable: the current bridge or target is missing." }] };
      }
      const created = await askBridgeRequest(settings, fetchImpl, "POST", "/v1/asks", {
        conversationId: settings.interactionConversationId,
        producerConversationId: settings.producerConversationId,
        runId: settings.runId,
        message: args.message,
        questions: args.questions,
        timeoutMs: settings.timeoutMs,
      }, extra.signal);
      if (created.status === 409) {
        return askToolResult(
          "A question is already pending for the user. Wait for its answer instead of asking again.",
          { answered: false, reason: "already_pending" },
        );
      }
      if (created.status === 501) {
        return askToolResult(
          "This conversation's channel does not support interactive asks. Ask your question in your final reply instead.",
          { answered: false, reason: "unsupported_channel" },
        );
      }
      if (created.status !== 201 || typeof created.body.interactionId !== "string") {
        throw new Error(`AskUser: the interaction bridge rejected the ask (HTTP ${String(created.status)}).`);
      }
      return await awaitBridgeAsk(settings, created.body.interactionId, extra, fetchImpl, extra.signal);
    },
  );
}

function askToolResult(
  text: string,
  structured: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, ...structured },
  };
}

async function awaitBridgeAsk(
  settings: AskUserToolSettings,
  interactionId: string,
  extra: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }> {
  const startedMs = Date.now();
  try {
    for (;;) {
      const poll = await askBridgeRequest(
        settings,
        fetchImpl,
        "GET",
        `/v1/asks/${encodeURIComponent(interactionId)}?waitMs=${String(ASK_USER_POLL_WAIT_MS)}`,
        undefined,
        signal,
      );
      if (poll.status !== 200) {
        throw new Error(`AskUser: lost the pending ask (HTTP ${String(poll.status)}).`);
      }
      // Keep-alive: progress notifications reset the runtime's MCP inactivity
      // timeout so a long human wait cannot kill the tool call.
      await sendAskProgress(extra, Math.round((Date.now() - startedMs) / 1000));
      const status = poll.body.status;
      if (status === "answered") {
        const answer = formatBridgeAskAnswers(poll.body);
        return askToolResult(`The user answered:\n${answer.text}`, {
          answered: true,
          interactionId,
          answers: answer.answers,
        });
      }
      if (status === "expired") {
        const partial = formatBridgeAskAnswers(poll.body);
        return askToolResult(
          `${partial.answers.length === 0 ? "The user did not answer" : `The user answered only:\n${partial.text}\n\nThe remaining questions were not answered`} within the wait window. Their next message will be a new turn; finish gracefully and state any assumptions.`,
          { answered: false, reason: "timeout", interactionId, answers: partial.answers },
        );
      }
      if (status === "cancelled") {
        return askToolResult("The user cancelled the current run. Stop this task.", {
          answered: false,
          reason: "cancelled",
          interactionId,
        });
      }
    }
  } catch (error) {
    // A cancelled MCP call must not leave a bridge ask pending until its full
    // human timeout. Cleanup gets its own bounded signal (not the aborted call
    // signal), and its failure must never replace the primary tool failure.
    await cleanupBridgeAskBestEffort(settings, fetchImpl, interactionId);
    throw error;
  }
}

function formatBridgeAskAnswers(body: Record<string, unknown>): {
  readonly text: string;
  readonly answers: readonly Record<string, unknown>[];
} {
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const normalized: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const rawAnswer of answers) {
    if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) continue;
    const answer = rawAnswer as Record<string, unknown>;
    const questionId = typeof answer.questionId === "string" ? answer.questionId : undefined;
    if (questionId === undefined) continue;
    const question = questions.find((candidate) =>
      typeof candidate === "object"
      && candidate !== null
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).id === questionId
    ) as Record<string, unknown> | undefined;
    const options = Array.isArray(question?.options) ? question.options : [];
    const selectedOptionIds = Array.isArray(answer.selectedOptionIds)
      ? answer.selectedOptionIds.filter((value): value is string => typeof value === "string")
      : [];
    const selectedOptions = selectedOptionIds.flatMap((optionId) => {
      const option = options.find((candidate) =>
        typeof candidate === "object"
        && candidate !== null
        && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).id === optionId
      ) as Record<string, unknown> | undefined;
      return typeof option?.label === "string"
        ? [{ id: optionId, label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }]
        : [];
    });
    const customReply = typeof answer.customReply === "string" ? answer.customReply : undefined;
    const header = typeof question?.header === "string" ? question.header : questionId;
    const rendered = [
      ...selectedOptions.map((option) => option.label),
      ...(customReply === undefined ? [] : [customReply]),
    ].join(", ");
    lines.push(`- ${header}: ${rendered}`);
    normalized.push({
      questionId,
      header,
      selectedOptions,
      ...(customReply === undefined ? {} : { customReply }),
    });
  }
  return { text: lines.join("\n") || "(no answers)", answers: normalized };
}

async function cleanupBridgeAskBestEffort(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  interactionId: string,
): Promise<void> {
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error("interaction bridge ask cleanup timed out"));
      resolve();
    }, ASK_BRIDGE_CLEANUP_TIMEOUT_MS);
    deadlineTimer.unref?.();
  });
  // Attach the rejection handler before racing. If a test seam or nonstandard
  // fetch ignores abort and rejects later, it cannot become an unhandled error.
  const cleanup = askBridgeRequest(
    settings,
    fetchImpl,
    "DELETE",
    `/v1/asks/${encodeURIComponent(interactionId)}`,
    undefined,
    controller.signal,
  ).then(() => undefined, () => undefined);
  try {
    await Promise.race([cleanup, deadline]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}

async function askBridgeRequest(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(new URL(path, settings.bridgeUrl), {
    method,
    headers: {
      authorization: `Bearer ${settings.bridgeToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
}

async function sendAskProgress(extra: unknown, elapsedSeconds: number): Promise<void> {
  const handler = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: unknown) => Promise<void>;
  };
  const progressToken = handler._meta?.progressToken;
  if (progressToken === undefined || handler.sendNotification === undefined) {
    return;
  }
  try {
    await handler.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedSeconds,
        message: `waiting for the user's reply (${String(elapsedSeconds)}s)`,
      },
    });
  } catch {
    // Keep-alive only; a lost notification must never fail the ask.
  }
}
