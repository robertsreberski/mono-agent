import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import type {
  TuiHistoryMessage,
  TuiHistoryStatus,
  TuiHistoryStore,
} from "../agent/history.js";

export interface HistoryPaneProps {
  readonly history: TuiHistoryStore;
  readonly active: boolean;
  readonly previewChars?: number;
}

const DEFAULT_PREVIEW_CHARS = 80;

const STATUS_COLOR: Record<TuiHistoryStatus, string> = {
  ok: "green",
  cancelled: "yellow",
  error: "red",
};

function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) {
    return "—";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function preview(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1)}…`;
}

interface HistoryDetailViewProps {
  readonly message: TuiHistoryMessage;
}

function HistoryDetailView({ message }: HistoryDetailViewProps): React.JSX.Element {
  const meta = message.metadata;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{message.role === "user" ? "you" : "agent"}</Text>
        <Text color="gray">  ·  {formatTimestamp(message.timestamp)}</Text>
        {message.status !== undefined && message.status !== "ok" ? (
          <Text color={STATUS_COLOR[message.status]}>
            {"  ·  "}
            {message.status}
          </Text>
        ) : null}
      </Box>
      {message.conversationId !== undefined ? (
        <Box>
          <Text color="gray">conversation: {message.conversationId}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text>{message.text.length === 0 ? "(empty)" : message.text}</Text>
      </Box>
      {meta !== undefined ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">metadata</Text>
          {Object.entries(meta).map(([key, value]) => (
            <Text key={key} color="gray">
              {"  "}
              {key}: {formatMetaValue(value)}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">esc to return · del to remove</Text>
      </Box>
    </Box>
  );
}

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}

export function HistoryPane({
  history,
  active,
  previewChars = DEFAULT_PREVIEW_CHARS,
}: HistoryPaneProps): React.JSX.Element {
  const [, force] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);

  useEffect(() => {
    return history.subscribe(() => {
      force((n) => n + 1);
    });
  }, [history]);

  const messages = history.list();

  // Clamp selection if messages shrink.
  useEffect(() => {
    if (selectedIndex >= messages.length && messages.length > 0) {
      setSelectedIndex(messages.length - 1);
    }
    if (messages.length === 0) {
      setSelectedIndex(0);
      setDetailId(undefined);
    }
  }, [messages.length, selectedIndex]);

  const detailMessage = useMemo(
    () =>
      detailId === undefined
        ? undefined
        : messages.find((message) => message.id === detailId),
    [messages, detailId],
  );

  useInput(
    (input, key) => {
      if (messages.length === 0) {
        return;
      }
      if (detailMessage !== undefined) {
        if (key.escape) {
          setDetailId(undefined);
          return;
        }
        if (key.delete || key.backspace) {
          history.remove(detailMessage.id);
          setDetailId(undefined);
          return;
        }
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((index) =>
          Math.min(messages.length - 1, index + 1),
        );
        return;
      }
      if (key.return) {
        const target = messages[selectedIndex];
        if (target !== undefined) {
          setDetailId(target.id);
        }
        return;
      }
      if (key.delete || key.backspace) {
        const target = messages[selectedIndex];
        if (target !== undefined) {
          history.remove(target.id);
        }
      }
    },
    { isActive: active },
  );

  if (messages.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">history is empty.</Text>
      </Box>
    );
  }

  if (detailMessage !== undefined) {
    return <HistoryDetailView message={detailMessage} />;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="gray">↑↓ select · enter open · del remove</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {messages.map((message, index) => {
          const isSelected = index === selectedIndex;
          const marker = isSelected ? "›" : " ";
          const roleLabel = message.role === "user" ? "you" : "agent";
          const statusBadge =
            message.status !== undefined && message.status !== "ok"
              ? ` (${message.status})`
              : "";
          return (
            <Box key={message.id}>
              <Text color={isSelected ? "cyan" : "gray"}>{marker} </Text>
              <Text color="gray">{formatTimestamp(message.timestamp)}  </Text>
              <Text color={message.role === "user" ? "blueBright" : "magenta"} bold>
                {roleLabel}
              </Text>
              <Text>{statusBadge}  </Text>
              <Text>{preview(message.text, previewChars)}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
