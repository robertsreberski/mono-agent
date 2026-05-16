import React from "react";
import { Box, Text } from "ink";

export type BadgeTone = "neutral" | "info" | "warning" | "error" | "success";

const TONE_COLORS: Record<BadgeTone, string> = {
  neutral: "gray",
  info: "cyan",
  warning: "yellow",
  error: "red",
  success: "green",
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: React.ReactNode;
}

export function Badge({ tone = "neutral", children }: BadgeProps): React.JSX.Element {
  return (
    <Box>
      <Text color={TONE_COLORS[tone]}>{children}</Text>
    </Box>
  );
}
