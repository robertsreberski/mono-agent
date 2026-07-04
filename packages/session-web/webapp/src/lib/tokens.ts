// Design tokens — exact values from the Session Recorder mock.

import type { CSSProperties } from "react";

/** Inline-style object that may also carry CSS custom properties (--glow, …). */
export type Style = CSSProperties & { [k: `--${string}`]: string | number };

export const BG_BASE = "#0a0b0e";

// The page atmosphere: amber top-right, teal top-left, over the base.
export const PAGE_BG =
  "radial-gradient(1200px 600px at 78% -8%, rgba(232,162,74,.10), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 8%, rgba(79,182,166,.07), transparent 55%)," +
  BG_BASE;

export const TEXT = "#ECEAE3";
export const MUTED = "#9A9CA4";
export const DIM = "#868a93";
export const DIMMER = "#8a8d95";

// Channel palette (how a run was triggered). Covers every `source` the backend
// can emit (see deriveRunSource / mapRunToSession) so no real run falls through
// to a colourless "other". Each hue is visually distinct on the dark ground.
export const CHANNEL_COLOR: Record<string, string> = {
  cron: "#4FB6A6", // teal
  webhook: "#B18AE0", // violet
  chat: "#6FA8DC", // blue
  memory: "#E0955A", // orange
  slack: "#6FBF8E", // green
  telegram: "#5EC8E8", // cyan
  "openai-api": "#C6B85E", // olive-gold
  a2a: "#D98BB0", // pink
  tui: "#E8A24A", // amber
  other: "#8b8d94", // grey
};
export const CHANNEL_LABEL: Record<string, string> = {
  cron: "Cron",
  webhook: "Webhook",
  chat: "Chat",
  memory: "Memory",
  slack: "Slack",
  telegram: "Telegram",
  "openai-api": "OpenAI API",
  a2a: "A2A",
  tui: "TUI",
  other: "Other",
};
/** Display/filter order for channels (present ones are shown; absent ones skipped). */
export const CHANNEL_ORDER = [
  "cron",
  "webhook",
  "chat",
  "memory",
  "slack",
  "telegram",
  "openai-api",
  "a2a",
  "tui",
  "other",
] as const;

// Accents.
export const AMBER = "#E8A24A"; // cost
export const BLUE = "#6FA8DC"; // tokens
export const TEAL = "#4FB6A6"; // tools
export const VIOLET = "#B18AE0"; // reasoning
export const OK = "#6FBF8E";
export const ERROR = "#E0685B"; // + rec dot

// Surfaces.
export const CARD_SURFACE =
  "linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.014))";
export const BORDER = "rgba(255,255,255,.08)";

// Fonts.
export const FONT_UI = "'Space Grotesk', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', monospace";
export const FONT_SERIF = "'Newsreader', Georgia, serif";
