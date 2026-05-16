import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import type { TuiHistoryMessage, TuiHistoryStore } from "../agent/history.js";
import {
  isTuiAgentCancelledError,
  type AgentRequestLike,
  type AgentResponderLike,
} from "../agent/responder.js";
import {
  TuiInkMessageStream,
  type TuiStreamState,
} from "../agent/message-stream.js";
import { Spinner } from "./primitives/Spinner.js";
import { Badge } from "./primitives/Badge.js";
import { TranscriptLine } from "./primitives/TranscriptLine.js";

export interface ChatPaneProps {
  readonly responder: AgentResponderLike;
  readonly history: TuiHistoryStore;
  readonly conversationId: string;
  readonly active: boolean;
  readonly initialStatusText?: string;
  readonly streamDebounceMs?: number;
  readonly maxTranscriptLines?: number;
  readonly idGenerator?: () => string;
  readonly clock?: () => number;
  readonly logger?: {
    debug?: (message: string, metadata?: Record<string, unknown>) => void;
    error?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}

type ChatStatus = "idle" | "streaming" | "cancelling";

interface InFlight {
  readonly userMessage: TuiHistoryMessage;
  readonly assistantId: string;
  readonly stream: TuiInkMessageStream;
  readonly controller: AbortController;
}

const DEFAULT_MAX_TRANSCRIPT = 30;

function defaultIdGenerator(): string {
  return `msg_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function ChatPane({
  responder,
  history,
  conversationId,
  active,
  initialStatusText,
  streamDebounceMs,
  maxTranscriptLines = DEFAULT_MAX_TRANSCRIPT,
  idGenerator = defaultIdGenerator,
  clock = Date.now,
  logger,
}: ChatPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [streamState, setStreamState] = useState<TuiStreamState | undefined>(
    undefined,
  );
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [, forceRender] = useState(0);
  const inFlightRef = useRef<InFlight | undefined>(undefined);

  // Re-render when history changes so the transcript stays in sync.
  useEffect(() => {
    return history.subscribe(() => {
      forceRender((n) => n + 1);
    });
  }, [history]);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || inFlightRef.current !== undefined) {
        return;
      }
      setErrorText(undefined);
      setDraft("");

      const userMessage: TuiHistoryMessage = {
        id: idGenerator(),
        role: "user",
        text,
        timestamp: clock(),
        conversationId,
      };
      history.append(userMessage);

      const assistantId = idGenerator();
      const controller = new AbortController();
      const stream = new TuiInkMessageStream({
        ...(initialStatusText === undefined ? {} : { initialStatusText }),
        ...(streamDebounceMs === undefined ? {} : { streamDebounceMs }),
        onState: (state) => {
          setStreamState(state);
        },
      });
      const inFlight: InFlight = {
        userMessage,
        assistantId,
        stream,
        controller,
      };
      inFlightRef.current = inFlight;
      setStatus("streaming");
      setStreamState(stream.snapshot());

      const request: AgentRequestLike = {
        conversationId,
        text,
        abortSignal: controller.signal,
        metadata: { source: "tui" },
      };

      try {
        const response = await responder.respond(request, stream);
        stream.flushPending();
        const finalText = response.text ?? stream.snapshot().text;
        history.append({
          id: assistantId,
          role: "assistant",
          text: finalText,
          timestamp: clock(),
          conversationId,
          status: "ok",
          ...(response.metadata === undefined
            ? {}
            : { metadata: response.metadata }),
        });
      } catch (error) {
        stream.flushPending();
        const partial = stream.snapshot().text;
        if (isTuiAgentCancelledError(error) || controller.signal.aborted) {
          history.append({
            id: assistantId,
            role: "assistant",
            text: partial,
            timestamp: clock(),
            conversationId,
            status: "cancelled",
          });
        } else {
          const message =
            error instanceof Error ? error.message : String(error);
          setErrorText(message);
          logger?.error?.("agent.respond.failed", { message });
          history.append({
            id: assistantId,
            role: "assistant",
            text: partial.length > 0 ? partial : message,
            timestamp: clock(),
            conversationId,
            status: "error",
            metadata: { errorMessage: message },
          });
        }
      } finally {
        inFlightRef.current = undefined;
        setStreamState(undefined);
        setStatus("idle");
      }
    },
    [
      responder,
      history,
      conversationId,
      initialStatusText,
      streamDebounceMs,
      idGenerator,
      clock,
      logger,
    ],
  );

  useInput(
    (_input, key) => {
      if (key.escape && inFlightRef.current !== undefined) {
        setStatus("cancelling");
        inFlightRef.current.controller.abort();
      }
    },
    { isActive: active },
  );

  const messages = history.list();
  const visible = useMemo(
    () =>
      messages.length > maxTranscriptLines
        ? messages.slice(messages.length - maxTranscriptLines)
        : messages,
    [messages, maxTranscriptLines],
  );

  const inputBadge: { tone: "info" | "warning" | "neutral"; label: string } =
    status === "streaming"
      ? { tone: "info", label: "streaming" }
      : status === "cancelling"
        ? { tone: "warning", label: "cancelling" }
        : { tone: "neutral", label: "idle" };

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1} paddingY={0}>
        {visible.length === 0 && streamState === undefined ? (
          <Text color="gray">
            no messages yet. type a message and press enter to talk to the agent.
          </Text>
        ) : null}
        {visible.map((message) => (
          <TranscriptLine
            key={message.id}
            role={message.role}
            text={message.text}
            {...(message.status === undefined ? {} : { status: message.status })}
          />
        ))}
        {streamState !== undefined ? (
          <TranscriptLine role="assistant" text={streamState.text} streaming />
        ) : null}
        {streamState !== undefined ? (
          <Spinner label={streamState.statusText} />
        ) : null}
        {errorText !== undefined ? (
          <Box>
            <Text color="red">error: {errorText}</Text>
          </Box>
        ) : null}
      </Box>
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="row"
      >
        <Box flexGrow={1}>
          <Text color="gray">{"› "}</Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={handleSubmit}
            placeholder="ask the agent…"
            focus={active && status !== "streaming" && status !== "cancelling"}
          />
        </Box>
        <Box marginLeft={1}>
          <Badge tone={inputBadge.tone}>[{inputBadge.label}]</Badge>
        </Box>
      </Box>
    </Box>
  );
}
