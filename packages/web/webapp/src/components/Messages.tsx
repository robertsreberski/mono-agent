import {
  ActionBarPrimitive,
  ChainOfThoughtPrimitive,
  MessagePrimitive,
  type DataMessagePartProps,
  type EmptyMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type PropsWithChildren, useEffect, useState } from "react";
import { UserMessageAttachments } from "./Attachments";
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

function ReasoningPart({ text }: ReasoningMessagePartProps) {
  return <p className="reasoning-text">{text}</p>;
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

function ThoughtLayout({ children }: PropsWithChildren) {
  return <div className="thought-parts">{children}</div>;
}

function ChainOfThought() {
  return (
    <ChainOfThoughtPrimitive.Root className="chain-of-thought">
      <ChainOfThoughtPrimitive.AccordionTrigger className="thought-trigger">
        <span className="thought-mark">
          <Icon name="spark" size={14} />
        </span>
        <span className="thought-label">Reasoning &amp; actions</span>
        <Icon className="thought-chevron" name="chevron" size={14} />
      </ChainOfThoughtPrimitive.AccordionTrigger>
      <ChainOfThoughtPrimitive.Parts
        components={{
          Reasoning: ReasoningPart,
          tools: { Fallback: ToolFallback },
          Layout: ThoughtLayout,
        }}
      />
    </ChainOfThoughtPrimitive.Root>
  );
}

export function TelemetryPart({ data }: DataMessagePartProps) {
  const payload = data as { event?: unknown; data?: unknown };
  const event = String(payload.event ?? "event");
  const detail = payload.data;
  const detailRecord = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const kind = typeof detailRecord.kind === "string" ? detailRecord.kind : "";
  const normalized = `${event} ${kind}`.toLowerCase();
  if (normalized.includes("warning") || normalized.includes("failover")) {
    const message =
      detail && typeof detail === "object" && "message" in detail
        ? String((detail as { message?: unknown }).message ?? event)
        : kind === "failover_started"
          ? `${String(detailRecord.from ?? "Current model")} → ${String(detailRecord.to ?? "fallback")}`
          : kind === "failover_completed"
            ? `Answered by ${String(detailRecord.model ?? "fallback model")}`
        : typeof detail === "string"
          ? detail
          : event.replaceAll("_", " ");
    return (
      <div className="runtime-notice" role="status">
        <span className="runtime-notice-icon">!</span>
        <div>
          <strong>{normalized.includes("failover") ? "Model failover" : "Runtime warning"}</strong>
          <span>{message}</span>
        </div>
      </div>
    );
  }
  if (event === "usage_update" || normalized.includes("usage") || normalized.includes("cost")) {
    const tokens =
      detailRecord.tokens && typeof detailRecord.tokens === "object"
        ? detailRecord.tokens as Record<string, unknown>
        : detailRecord;
    const input = numberValue(tokens.input ?? tokens.input_tokens ?? tokens.inputTokens);
    const output = numberValue(tokens.output ?? tokens.output_tokens ?? tokens.outputTokens);
    const cache = numberValue(tokens.cacheRead ?? tokens.cache_read_tokens);
    const cost = numberValue(
      detailRecord.cumulativeUsd ?? detailRecord.totalUsd ?? detailRecord.cost_usd,
    );
    return (
      <div className="telemetry-metrics" aria-label="Token usage and cost">
        <span>Usage</span>
        <code>
          {input !== undefined ? `↑${formatTokens(input)}` : ""}
          {output !== undefined ? ` ↓${formatTokens(output)}` : ""}
          {cache !== undefined && cache > 0 ? ` · cache ${formatTokens(cache)}` : ""}
          {cost !== undefined ? ` · $${cost.toFixed(cost < 0.01 ? 4 : 2)}` : ""}
        </code>
      </div>
    );
  }
  return (
    <details className="telemetry-part">
      <summary>
        <span>Telemetry</span>
        <strong>{event}</strong>
      </summary>
      {payload.data !== undefined && <pre>{safeJson(payload.data)}</pre>}
    </details>
  );
}

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${Math.round((tokens / 1_000_000) * 10) / 10}m`
    : tokens >= 1_000
      ? `${Math.round((tokens / 1_000) * 10) / 10}k`
      : String(tokens);

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
  ChainOfThought,
  data: {
    by_name: {
      telemetry: TelemetryPart,
      error: ErrorPart,
    },
  },
} as const;

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-user-content">
        <UserMessageAttachments />
        <MessagePrimitive.Parts components={parts} />
      </div>
      <ActionBarPrimitive.Root className="message-actions" autohide="always">
        <MessageCopyButton label="Copy message" />
      </ActionBarPrimitive.Root>
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
        <MessagePrimitive.Parts components={parts} />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <ActionBarPrimitive.Root className="message-actions" autohide="not-last">
          <MessageCopyButton label="Copy response" />
        </ActionBarPrimitive.Root>
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
