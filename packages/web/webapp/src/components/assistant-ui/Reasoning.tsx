"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import {
  groupPartByType,
  type ReasoningMessagePartComponent,
  useScrollLock,
} from "@assistant-ui/react";
import {
  createContext,
  Fragment,
  memo,
  type ComponentProps,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActivityRow } from "../ActivityRow";
import { formatToolDuration } from "../duration";
import { Icon } from "../Icon";

const ANIMATION_DURATION_MS = 200;

const joinClassNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" ");

const ReasoningPreviewContext = createContext(false);

export const REASONING_GROUP_BY = groupPartByType({
  reasoning: ["group-reasoning"] as const,
});

const ACTIVITY_GROUP_BY_TYPE = groupPartByType({
  reasoning: ["group-activity"] as const,
  "tool-call": ["group-activity"] as const,
  "standalone-tool-call": [] as const,
});

/**
 * Named data parts that are user-visible activity rather than diagnostics.
 * `note` is the prose a settled turn wrote between its tool calls: working-out,
 * not the answer, so it belongs in the log with the rows it narrates.
 */
export const ACTIVITY_DATA_PARTS: ReadonlySet<string> = new Set(
  ["context-compaction", "subagent", "note", "tool-cluster"],
);

export const ACTIVITY_GROUP_BY: typeof ACTIVITY_GROUP_BY_TYPE = (part, context) =>
  part.type === "data" && ACTIVITY_DATA_PARTS.has(part.name)
    ? ["group-activity"] as const
    : ACTIVITY_GROUP_BY_TYPE(part, context);

export interface ReasoningRootProps extends Omit<
  Collapsible.Root.Props,
  "className" | "defaultOpen" | "onOpenChange" | "open"
> {
  readonly className?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly defaultOpen?: boolean;
  /**
   * While supplied, streaming controls the disclosure until the user toggles
   * it. Streaming opens the live preview and settling collapses it.
   */
  readonly streaming?: boolean;
  /** Force a running disclosure closed when the message reaches a terminal state. */
  readonly collapseOnSettle?: boolean;
}

export function ReasoningRoot({
  className,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  streaming,
  collapseOnSettle = false,
  children,
  ...props
}: ReasoningRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const initialOpenRef = useRef(defaultOpen);
  const previousStreamingRef = useRef(streaming);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lockScroll = useScrollLock(rootRef, ANIMATION_DURATION_MS);

  const controlled = controlledOpen !== undefined;
  const open = controlled
    ? controlledOpen
    : (userOpen ?? streaming ?? initialOpenRef.current);
  const automatic = controlled || userOpen === null;
  const preview = streaming === true && open && automatic;

  useLayoutEffect(() => {
    if (previousStreamingRef.current === streaming) return;
    const wasStreaming = previousStreamingRef.current;
    previousStreamingRef.current = streaming;
    if (collapseOnSettle && wasStreaming === true && streaming === false && !controlled) {
      setUserOpen(false);
    }
    if (!controlled && userOpen === null) lockScroll();
  }, [collapseOnSettle, controlled, lockScroll, streaming, userOpen]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    lockScroll();
    if (!controlled) setUserOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [controlled, lockScroll, onOpenChange]);

  return (
    <Collapsible.Root
      {...props}
      ref={rootRef}
      data-slot="reasoning-root"
      data-streaming={streaming ? "true" : undefined}
      open={open}
      onOpenChange={handleOpenChange}
      className={joinClassNames("reasoning-root", className)}
    >
      <ReasoningPreviewContext.Provider value={preview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible.Root>
  );
}

export interface ReasoningTriggerProps extends Omit<
  Collapsible.Trigger.Props,
  "children" | "className"
> {
  readonly active?: boolean;
  readonly className?: string;
  readonly duration?: number;
  readonly children?: ReactNode;
}

export function ReasoningTrigger({
  active = false,
  className,
  duration,
  children,
  ...props
}: ReasoningTriggerProps) {
  const durationText = typeof duration === "number" && duration > 0
    ? ` (${duration}s)`
    : "";

  return (
    <Collapsible.Trigger
      {...props}
      data-slot="reasoning-trigger"
      data-active={active ? "true" : undefined}
      className={joinClassNames("reasoning-trigger", className)}
    >
      {children ?? (
        <>
          <span
            data-slot="reasoning-trigger-icon"
            className="reasoning-trigger-icon"
            aria-hidden="true"
          >
            <Icon name="spark" size={14} />
          </span>
          <span
            data-slot="reasoning-trigger-label"
            className="reasoning-trigger-label"
          >
            Reasoning{durationText}
            {active && <span className="sr-only"> in progress</span>}
          </span>
          <Icon
            data-slot="reasoning-trigger-chevron"
            className="reasoning-trigger-chevron"
            name="chevron"
            size={14}
          />
        </>
      )}
    </Collapsible.Trigger>
  );
}

export interface ReasoningContentProps extends Omit<
  Collapsible.Panel.Props,
  "className"
> {
  readonly className?: string;
}

export function ReasoningContent({
  className,
  children,
  ...props
}: ReasoningContentProps) {
  return (
    <Collapsible.Panel
      {...props}
      data-slot="reasoning-content"
      className={joinClassNames("reasoning-content", className)}
    >
      {children}
    </Collapsible.Panel>
  );
}

export interface ReasoningTextProps extends ComponentProps<"div"> {
  readonly className?: string;
}

export function ReasoningText({
  className,
  children,
  ...props
}: ReasoningTextProps) {
  const preview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview) return;
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;

    const pinToBottom = () => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    };
    pinToBottom();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [preview]);

  return (
    <div
      {...props}
      ref={scrollRef}
      data-slot="reasoning-text"
      className={joinClassNames("reasoning-text", className)}
    >
      <div
        ref={contentRef}
        data-slot="reasoning-text-content"
        className="reasoning-text-content"
      >
        {children}
      </div>
    </div>
  );
}

const renderParagraph = (paragraph: string, paragraphIndex: number) => (
  <p key={paragraphIndex} data-slot="reasoning-paragraph">
    {paragraph.split("\n").map((line, lineIndex, lines) => (
      <Fragment key={lineIndex}>
        {line}
        {lineIndex < lines.length - 1 && <br />}
      </Fragment>
    ))}
  </p>
);

const THINKING_PREVIEW_CHARACTERS = 52;

/**
 * A thought's preview is the row's only content, so it has to read as prose. The
 * expanded body still renders the raw text; this only strips the emphasis and
 * heading markers that would otherwise be the first thing the eye lands on.
 */
const thinkingPreview = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[*_`>#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Thinking is working-out, not an answer: it collapses to one row so a long
 * chain of thought cannot bury the tool calls it sits between, and expands in
 * place for anyone who wants to read it.
 */
const ReasoningImpl: ReasoningMessagePartComponent = ({ text, status }) => {
  if (text.length === 0) return null;
  const preview = thinkingPreview(text);
  // A thought still arriving stays open — watching the model work is the whole
  // reason Activity auto-opens — and folds itself away once it has settled.
  // `undefined` rather than `false`, so settling removes the attribute instead
  // of forcing the row shut under anyone who opened it by hand.
  const streaming = status?.type === "running";
  return (
    <ActivityRow
      variant="thinking"
      status={streaming ? "running" : "complete"}
      summary={preview.length > THINKING_PREVIEW_CHARACTERS
        ? `${preview.slice(0, THINKING_PREVIEW_CHARACTERS - 1)}\u2026`
        : preview}
      open={streaming || undefined}
    >
      <div data-slot="reasoning-part" className="reasoning-part activity-thought">
        {text.split(/\n{2,}/u).map(renderParagraph)}
      </div>
    </ActivityRow>
  );
};

export interface ReasoningGroupProps extends PropsWithChildren {
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly duration?: number;
  readonly status?: { readonly type: string };
  readonly streaming?: boolean;
}

export interface ActivityGroupProps extends PropsWithChildren {
  readonly className?: string;
  /** Summed tool durations, omitted when the turn reported none. */
  readonly elapsedMs?: number;
  readonly status?: { readonly type: string };
  readonly stepCount?: number;
  readonly streaming?: boolean;
}

const ReasoningGroupImpl = ({
  children,
  className,
  defaultOpen,
  duration,
  status,
  streaming,
}: ReasoningGroupProps) => {
  const isStreaming = streaming ?? status?.type === "running";
  return (
    <ReasoningRoot
      className={className}
      defaultOpen={defaultOpen}
      streaming={isStreaming}
    >
      <ReasoningTrigger active={isStreaming} duration={duration} />
      <ReasoningContent aria-busy={isStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

export const Reasoning = Object.assign(memo(ReasoningImpl), {
  Root: ReasoningRoot,
  Trigger: ReasoningTrigger,
  Content: ReasoningContent,
  Text: ReasoningText,
}) as ReasoningMessagePartComponent & {
  readonly Root: typeof ReasoningRoot;
  readonly Trigger: typeof ReasoningTrigger;
  readonly Content: typeof ReasoningContent;
  readonly Text: typeof ReasoningText;
};

Reasoning.displayName = "Reasoning";

export const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";

const ActivityGroupImpl = ({
  children,
  className,
  elapsedMs,
  status,
  stepCount,
  streaming,
}: ActivityGroupProps) => {
  const isStreaming = streaming ?? status?.type === "running";
  const elapsed = elapsedMs === undefined ? undefined : formatToolDuration(elapsedMs);
  const meta = [
    stepCount === undefined ? undefined : `${String(stepCount)} ${stepCount === 1 ? "step" : "steps"}`,
    elapsed,
  ].filter((value): value is string => value !== undefined).join(" \u00b7 ");
  return (
    <ReasoningRoot
      className={joinClassNames("activity-root", className)}
      collapseOnSettle
      open={isStreaming ? true : undefined}
      streaming={isStreaming}
    >
      <ReasoningTrigger active={isStreaming} className="activity-trigger">
        <Icon className={`activity-glyph${isStreaming ? " is-running" : ""}`} name="activity" size={13} />
        <span className="reasoning-trigger-label">
          Activity{isStreaming && <span className="sr-only"> in progress</span>}
        </span>
        {/* Scanning aids only. They change on every streaming snapshot, so keeping
            them out of the accessible name stops the trigger being re-announced
            each tick; the rows themselves carry the same detail. */}
        {meta.length > 0 && (
          <span className="activity-meta" aria-hidden="true">{meta}</span>
        )}
        <Icon className="activity-chevron" name="chevron-down" size={14} />
      </ReasoningTrigger>
      <ReasoningContent className="activity-content" aria-busy={isStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

export const ActivityGroup = memo(ActivityGroupImpl);
ActivityGroup.displayName = "ActivityGroup";
