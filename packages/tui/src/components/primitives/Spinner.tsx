import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";

export interface SpinnerProps {
  readonly label: string;
}

export function Spinner({ label }: SpinnerProps): React.JSX.Element {
  return (
    <Box>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      <Text> {label}</Text>
    </Box>
  );
}
