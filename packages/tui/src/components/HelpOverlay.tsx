import React from "react";
import { Box, Text } from "ink";

import { TUI_PACKAGE_VERSION } from "../runtime/version.js";

const KEYBINDINGS: ReadonlyArray<readonly [string, string]> = [
  ["tab / shift+tab", "cycle panes"],
  ["1 / 2 / 3", "jump to chat / history / config"],
  ["enter", "submit message (chat) · open detail (history)"],
  ["esc", "cancel in-flight response · close detail"],
  ["backspace / del", "remove highlighted history message"],
  ["r", "reload config from disk (config pane)"],
  ["?", "toggle this help overlay"],
  ["ctrl+c", "stop and exit"],
];

export interface HelpOverlayProps {
  readonly title: string;
}

export function HelpOverlay({ title }: HelpOverlayProps): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold>{title}</Text>
        <Text color="gray"> · v{TUI_PACKAGE_VERSION}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {KEYBINDINGS.map(([keys, description]) => (
          <Box key={keys}>
            <Text color="cyan">{keys.padEnd(18)}</Text>
            <Text>{description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">press ? again to close</Text>
      </Box>
    </Box>
  );
}
