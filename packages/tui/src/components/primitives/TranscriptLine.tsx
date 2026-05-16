import React from "react";
import { Box, Text } from "ink";

import type { TuiHistoryRole, TuiHistoryStatus } from "../../agent/history.js";

export interface TranscriptLineProps {
  readonly role: TuiHistoryRole;
  readonly text: string;
  readonly status?: TuiHistoryStatus;
  readonly streaming?: boolean;
}

const ROLE_LABEL: Record<TuiHistoryRole, string> = {
  user: "you",
  assistant: "agent",
};

const ROLE_COLOR: Record<TuiHistoryRole, string> = {
  user: "blueBright",
  assistant: "magenta",
};

export function TranscriptLine({
  role,
  text,
  status,
  streaming,
}: TranscriptLineProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={ROLE_COLOR[role]} bold>
          {ROLE_LABEL[role]}
        </Text>
        {status === "cancelled" ? (
          <Text color="yellow"> · cancelled</Text>
        ) : null}
        {status === "error" ? <Text color="red"> · error</Text> : null}
        {streaming ? <Text color="gray"> · streaming</Text> : null}
      </Box>
      <Box>
        <Text>{text.length === 0 ? " " : text}</Text>
      </Box>
    </Box>
  );
}
