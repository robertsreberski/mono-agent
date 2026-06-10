import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { AgentResponderLike } from "../agent/responder.js";
import { createInMemoryTuiHistory, type TuiHistoryStore } from "../agent/history.js";
import { ChatPane } from "./ChatPane.js";
import { HistoryPane } from "./HistoryPane.js";
import { ConfigPane } from "./ConfigPane.js";
import { StatusBar } from "./StatusBar.js";
import { HelpOverlay } from "./HelpOverlay.js";

export type TuiPaneId = "chat" | "history" | "config";

export interface TuiAppConfigPaneOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface TuiAppLogger {
  debug?: (message: string, metadata?: Record<string, unknown>) => void;
  info?: (message: string, metadata?: Record<string, unknown>) => void;
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
  error?: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface TuiAppProps {
  readonly responder: AgentResponderLike;
  readonly conversationId?: string;
  readonly history?: TuiHistoryStore;
  readonly title?: string;
  readonly subtitle?: string;
  readonly initialStatusText?: string;
  readonly streamDebounceMs?: number;
  readonly config?: TuiAppConfigPaneOptions;
  readonly exitOnCtrlC?: boolean;
  readonly logger?: TuiAppLogger;
}

const DEFAULT_TITLE = "Agent";
const DEFAULT_CONVERSATION_ID = "tui-local";

export function TuiApp({
  responder,
  conversationId = DEFAULT_CONVERSATION_ID,
  history,
  title = DEFAULT_TITLE,
  subtitle,
  initialStatusText,
  streamDebounceMs,
  config,
  exitOnCtrlC = true,
  logger,
}: TuiAppProps): React.JSX.Element {
  const [historyStore] = useState<TuiHistoryStore>(
    () => history ?? createInMemoryTuiHistory(),
  );
  const [activePane, setActivePane] = useState<TuiPaneId>("chat");
  const [helpOpen, setHelpOpen] = useState(false);
  const [ephemeral, setEphemeral] = useState<string | undefined>(undefined);
  const { exit } = useApp();

  const hasConfig = config !== undefined;

  useEffect(() => {
    if (ephemeral === undefined) {
      return;
    }
    const handle = setTimeout(() => setEphemeral(undefined), 2500);
    return () => clearTimeout(handle);
  }, [ephemeral]);

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "C")) {
      if (exitOnCtrlC) {
        exit();
      }
      return;
    }
    if (input === "?") {
      setHelpOpen((open) => !open);
      return;
    }
    if (helpOpen && key.escape) {
      setHelpOpen(false);
      return;
    }
    if (helpOpen) {
      return;
    }
    // Pane switching is suppressed while focus is in a text input. We
    // approximate that by routing pane hotkeys only when the chat pane is
    // not the active pane (its TextInput swallows printable keys), or via
    // tab which is not consumed by ink-text-input.
    if (key.tab) {
      const order: TuiPaneId[] = hasConfig
        ? ["chat", "history", "config"]
        : ["chat", "history"];
      const currentIndex = order.indexOf(activePane);
      const nextIndex = key.shift
        ? (currentIndex - 1 + order.length) % order.length
        : (currentIndex + 1) % order.length;
      const next = order[nextIndex];
      if (next !== undefined) {
        setActivePane(next);
        setEphemeral(`switched to ${next}`);
      }
      return;
    }
    if (activePane !== "chat") {
      if (input === "1") {
        setActivePane("chat");
        setEphemeral("switched to chat");
        return;
      }
      if (input === "2") {
        setActivePane("history");
        return;
      }
      if (input === "3" && hasConfig) {
        setActivePane("config");
        return;
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        <Text bold>{title}</Text>
        {subtitle !== undefined ? (
          <Text color="gray">{subtitle}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        {helpOpen ? <HelpOverlay title={title} /> : null}
        <Box display={activePane === "chat" ? "flex" : "none"}>
          <ChatPane
            responder={responder}
            history={historyStore}
            conversationId={conversationId}
            active={!helpOpen && activePane === "chat"}
            {...(initialStatusText === undefined ? {} : { initialStatusText })}
            {...(streamDebounceMs === undefined ? {} : { streamDebounceMs })}
            {...(logger === undefined ? {} : { logger })}
          />
        </Box>
        <Box display={activePane === "history" ? "flex" : "none"}>
          <HistoryPane
            history={historyStore}
            active={!helpOpen && activePane === "history"}
          />
        </Box>
        {hasConfig && config !== undefined ? (
          <Box display={activePane === "config" ? "flex" : "none"}>
            <ConfigPane
              configPath={config.path}
              cwd={config.cwd ?? process.cwd()}
              env={config.env ?? {}}
              active={!helpOpen && activePane === "config"}
              {...(logger === undefined ? {} : { logger })}
            />
          </Box>
        ) : null}
      </Box>
      <StatusBar
        activePane={activePane}
        hasConfig={hasConfig}
        title={title}
        {...(ephemeral === undefined ? {} : { ephemeral })}
      />
    </Box>
  );
}
