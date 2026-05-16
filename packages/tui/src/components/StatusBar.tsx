import React from "react";
import { Box, Text } from "ink";

import type { TuiPaneId } from "./TuiApp.js";

export interface StatusBarProps {
  readonly activePane: TuiPaneId;
  readonly hasConfig: boolean;
  readonly title: string;
  readonly ephemeral?: string;
}

const PANE_LABEL: Record<TuiPaneId, string> = {
  chat: "chat",
  history: "history",
  config: "config",
};

export function StatusBar({
  activePane,
  hasConfig,
  title,
  ephemeral,
}: StatusBarProps): React.JSX.Element {
  const panes: TuiPaneId[] = hasConfig
    ? ["chat", "history", "config"]
    : ["chat", "history"];

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box>
        <Text bold>{title}</Text>
        <Text color="gray">  ·  </Text>
        {panes.map((pane, index) => (
          <Box key={pane}>
            {index > 0 ? <Text color="gray">  </Text> : null}
            <Text
              color={pane === activePane ? "cyan" : "gray"}
              bold={pane === activePane}
            >
              {PANE_LABEL[pane]}
            </Text>
          </Box>
        ))}
      </Box>
      <Box>
        {ephemeral !== undefined && ephemeral.length > 0 ? (
          <Text color="yellow">{ephemeral}  </Text>
        ) : null}
        <Text color="gray">tab next · ? help · ctrl+c quit</Text>
      </Box>
    </Box>
  );
}
