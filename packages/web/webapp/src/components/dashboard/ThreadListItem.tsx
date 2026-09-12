import {
  ThreadListItemPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { threadPresentation } from "../../thread-presentation";
import type { AgentSummary, CatalogModel, ThreadSummary } from "../../types";
import { Icon } from "../Icon";
import { resolveThreadRoute } from "../route-label";
import { RouteBadge } from "../RouteBadge";
import { relativeTime } from "../time";
import {
  dashboardKindIcon,
  dashboardKindLabel,
  dashboardThreadKind,
} from "./dashboard-model";

/**
 * One conversation row, shared by Recent and the Project page.
 *
 * Extracted from `RecentSection` unchanged: the glyph says what the row IS,
 * the preview carries the running dot, and the selected row is marked only
 * where the conversation is on screen (see `highlightSelected`).
 */
export function ThreadListItem({
  thread,
  agent,
  catalogModels,
  unread,
  onNavigate,
  highlightSelected,
}: {
  readonly thread: ThreadSummary;
  /** The thread's OWN agent match; null when discovery no longer lists it. */
  readonly agent: AgentSummary | null;
  readonly catalogModels: Readonly<Record<string, readonly CatalogModel[]>> | undefined;
  /** This device has not seen the conversation as it now stands. */
  readonly unread: boolean;
  /** Closing the drawer belongs to the row that navigated, not to a click that
      happened to bubble through the list container. */
  readonly onNavigate?: () => void;
  /** The selected conversation is on screen, so saying which row it is means
      something. See {@link RecentSection}. */
  readonly highlightSelected: boolean;
}) {
  const selected = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const isActive = selected && highlightSelected;
  const presentation = threadPresentation(thread);
  const kind = dashboardThreadKind(thread);
  // Current settings for THIS conversation: its overrides, else its own
  // agent's config defaults. A span, so the row keeps its one navigation
  // target; the store re-render moves the badge with thread or agent updates,
  // without opening the conversation.
  const route = resolveThreadRoute(thread, agent, catalogModels);
  // The glyph says what the row IS; when a failure has taken the glyph, the
  // accessible name still says where the conversation came from.
  const kindName = thread.trigger && kind === "alert"
    ? `${dashboardKindLabel(kind)}, ${thread.trigger.kind} conversation`
    : dashboardKindLabel(kind);
  return (
    <ThreadListItemPrimitive.Root
      className={`thread-item${isActive ? " is-active" : ""}`}
    >
      <ThreadListItemPrimitive.Trigger
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
        onClick={onNavigate}
      >
        <span className={`thread-kind is-${kind}`} role="img" aria-label={kindName} title={kindName}>
          <Icon name={dashboardKindIcon(kind)} size={16} />
        </span>
        <span className="thread-copy">
          <span className="thread-title-line">
            <span className="thread-title">
              <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
            </span>
            {unread && <i className="thread-unread" role="img" aria-label="Unread" />}
            <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
          </span>
          <span className="thread-preview">
            {presentation.active && <i className="thread-running" role="img" aria-label={presentation.text} />}
            <span className="thread-preview-text" title={presentation.text}>
              {presentation.text}
            </span>
            <RouteBadge
              modelShort={route.modelShort}
              effortShort={route.effortShort}
              effortSignal={route.effortSignal}
              label={route.label}
              title={route.title}
            />
          </span>
        </span>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}
