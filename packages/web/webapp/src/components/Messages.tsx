import {
  ActionBarPrimitive,
  MessagePrimitive,
  type DataMessagePartProps,
  type EmptyMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useEffect, useState } from "react";
import { UserMessageAttachments } from "./Attachments";
import {
  ACTIVITY_GROUP_BY,
  ActivityGroup,
  Reasoning,
} from "./assistant-ui/Reasoning";
import { Icon } from "./Icon";

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const copyTextWithFallback = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // LAN HTTP and denied clipboard permissions can still use the selection fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    textarea.remove();
    active?.focus();
  }
  if (!copied) throw new Error("This browser did not allow clipboard access.");
};

export const copyableMessageText = (
  content: readonly { readonly type: string; readonly text?: string }[],
): string =>
  content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n");

function MessageCopyButton({ label }: { readonly label: string }) {
  const text = useAuiState((state) => copyableMessageText(state.message.content));
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={`message-action${state === "copied" ? " is-success" : state === "error" ? " is-error" : ""}`}
      aria-label={state === "copied" ? "Copied" : label}
      disabled={!text}
      onClick={() => {
        void copyTextWithFallback(text).then(
          () => setState("copied"),
          (error: unknown) => {
            setState("error");
            window.dispatchEvent(new CustomEvent("mono-agent:notice", {
              detail: {
                message: error instanceof Error ? error.message : "Copy failed.",
              },
            }));
          },
        );
      }}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      <span>{state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

function MessageActions({
  label,
  persistentWhenLast = false,
}: {
  readonly label: string;
  readonly persistentWhenLast?: boolean;
}) {
  const isLast = useAuiState((state) => state.message.isLast);
  return (
    <ActionBarPrimitive.Root
      className={`message-actions${persistentWhenLast && isLast ? " is-persistent" : ""}`}
      autohide="never"
    >
      <MessageCopyButton label={label} />
    </ActionBarPrimitive.Root>
  );
}

function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" defer smooth />;
}

function RunningText({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return (
    <span className="thinking-indicator" aria-label="Agent is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

export function ToolFallback({
  toolName,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  const isRunning = status.type === "running";
  return (
    <details className={`tool-call${isError ? " is-error" : ""}`}>
      <summary>
        <span className={`tool-status${isRunning ? " is-running" : ""}`} />
        <span className="tool-name">{toolName}</span>
        <span className="tool-state">
          {isRunning ? "running" : isError ? "failed" : result === undefined ? "called" : "done"}
        </span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{safeJson(args)}</pre>
        {result !== undefined && (
          <>
            <span>Output</span>
            <pre>{safeJson(result)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

// Runtime/provider telemetry remains attached to the message so the context
// display can summarize it, but transport diagnostics are not transcript UI.
function ErrorPart({ data }: DataMessagePartProps) {
  const payload = data as { code?: unknown; message?: unknown };
  return (
    <div className="message-error" role="alert">
      <strong>{payload.code ? String(payload.code) : "Agent error"}</strong>
      <span>{String(payload.message ?? "The agent run failed.")}</span>
    </div>
  );
}

const parts = {
  Text: MarkdownText,
  Empty: RunningText,
  data: {
    by_name: {
      error: ErrorPart,
    },
  },
} as const;

function AssistantParts() {
  return (
    <MessagePrimitive.GroupedParts groupBy={ACTIVITY_GROUP_BY} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-activity":
            return <ActivityGroup status={part.status}>{children}</ActivityGroup>;
          case "text":
            return part.text.length > 0
              ? <MarkdownText />
              : part.status.type === "running"
                ? <RunningText status={part.status} />
                : null;
          case "reasoning":
            return <Reasoning {...part} />;
          case "tool-call":
            return part.toolUI ?? <ToolFallback {...part} />;
          case "data":
            if (part.name === "telemetry") return null;
            if (part.name === "error") return <ErrorPart {...part} />;
            return part.dataRendererUI;
          case "indicator":
            return <RunningText status={{ type: "running" }} />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-user-content">
        <UserMessageAttachments />
        <MessagePrimitive.Parts components={parts} />
      </div>
      <MessageActions label="Copy message" />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="assistant-mark" aria-hidden="true">
        <Icon name="spark" size={15} />
      </div>
      <div className="assistant-content">
        <AssistantParts />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <MessageActions label="Copy response" persistentWhenLast />
      </div>
    </MessagePrimitive.Root>
  );
}

export function SystemMessage() {
  return (
    <MessagePrimitive.Root className="message message-system">
      <MessagePrimitive.Parts components={parts} />
    </MessagePrimitive.Root>
  );
}
