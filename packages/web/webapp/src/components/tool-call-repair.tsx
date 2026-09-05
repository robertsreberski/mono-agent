import { createContext, useContext, type ReactNode } from "react";

/**
 * Fetches one tool call's whole body and replaces the preview the transcript
 * was served with. Resolves to `true` when the transcript changed.
 */
export type ToolCallRepair = (toolCallId: string) => Promise<unknown>;

const ToolCallRepairContext = createContext<ToolCallRepair | null>(null);

/**
 * Hands the transcript a way back to the console's own state.
 *
 * Tool rows are rendered by assistant-ui from converted parts, so a row has no
 * props path to the store that holds the conversation it belongs to. This is
 * the one capability it needs: a preview row that can ask for the rest.
 */
export function ToolCallRepairProvider({
  repair,
  children,
}: {
  readonly repair: ToolCallRepair;
  readonly children: ReactNode;
}) {
  return <ToolCallRepairContext value={repair}>{children}</ToolCallRepairContext>;
}

/**
 * The repair capability, or `undefined` where there is none.
 *
 * A transcript rendered outside the console -- a component test, a future
 * read-only embed -- genuinely cannot fetch anything, and a preview row says
 * so by showing its marker without an offer to load the rest. It never pretends
 * a load succeeded.
 */
export function useToolCallRepair(): ToolCallRepair | undefined {
  return useContext(ToolCallRepairContext) ?? undefined;
}
