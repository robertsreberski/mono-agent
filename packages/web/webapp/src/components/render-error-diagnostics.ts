/**
 * Local-only evidence: exception strings are verbatim (and may quote content).
 * Context is an allowlisted metadata projection, never a transcript dump.
 * Nothing here persists or transmits the report off the device.
 */
const bounded = (value: string, limit: number): string => value.length > limit
  ? `${value.slice(0, limit)}…[truncated]` : value;

const stringify = (value: unknown): string => {
  try { return String(value); } catch { return "[unprintable]"; }
};

export interface SerializedRenderError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly type?: string;
  readonly cause?: SerializedRenderError;
  readonly errors?: readonly SerializedRenderError[];
  readonly omittedErrors?: number;
}

export function serializeRenderError(value: unknown, depth = 0, seen = new Set<unknown>()): SerializedRenderError {
  if (seen.has(value)) return { name: "CircularError", message: "[circular reference]" };
  if (depth > 3) return { name: "TruncatedError", message: "[maximum cause depth reached]" };
  if (!(value instanceof Error)) {
    return { name: "NonError", type: typeof value, message: bounded(stringify(value), 2_000) };
  }
  seen.add(value);
  // Read only named fields, never enumerable properties (which may hold a
  // request, transcript, credentials, or another unbounded object graph).
  const result: SerializedRenderError = {
    name: bounded(stringify(value.name), 160),
    message: bounded(stringify(value.message), 2_000),
    ...(typeof value.stack === "string" ? { stack: bounded(value.stack, 4_000) } : {}),
    ...(value.cause !== undefined ? { cause: serializeRenderError(value.cause, depth + 1, seen) } : {}),
    ...(value instanceof AggregateError ? {
      errors: value.errors.slice(0, 5).map((member: unknown) => serializeRenderError(member, depth + 1, seen)),
      omittedErrors: Math.max(0, value.errors.length - 5),
    } : {}),
  };
  seen.delete(value);
  return result;
}

type MessageShape = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly { readonly type: string }[];
};

export interface ConversationRenderContextInput {
  readonly selectedThreadId: string | null;
  readonly detailThreadId: string | null;
  readonly runtimeThreadId: string | null;
  readonly runtimeRemoteId: string | null;
  readonly runtimeAdapterThreadId: string | null;
  readonly loading: boolean;
  readonly detailLoading: boolean;
  readonly selectionLoading: boolean;
  readonly creatingThread: boolean;
  readonly runtimeLoading: boolean;
  readonly messages: readonly MessageShape[];
  readonly runtimeMessages: readonly MessageShape[];
}

const id = (value: string | null) => value === null ? null : bounded(value, 160);
const messageShapes = (messages: readonly MessageShape[]) => ({
  messageCount: messages.length,
  omittedMessages: Math.max(0, messages.length - 100),
  messages: messages.slice(0, 100).map((message) => ({
    id: id(message.id),
    role: bounded(message.role, 32),
    partCount: message.parts.length,
    partTypes: message.parts.slice(0, 32).map((part) => bounded(part.type, 80)),
    omittedParts: Math.max(0, message.parts.length - 32),
  })),
});

export function conversationRenderContext(input: ConversationRenderContextInput) {
  return {
    selectedThreadId: id(input.selectedThreadId),
    detailThreadId: id(input.detailThreadId),
    runtimeThreadId: id(input.runtimeThreadId),
    runtimeRemoteId: id(input.runtimeRemoteId),
    runtimeAdapterThreadId: id(input.runtimeAdapterThreadId),
    loading: Boolean(input.loading),
    detailLoading: Boolean(input.detailLoading),
    selectionLoading: Boolean(input.selectionLoading),
    creatingThread: Boolean(input.creatingThread),
    runtimeLoading: Boolean(input.runtimeLoading),
    detail: messageShapes(input.messages),
    runtime: messageShapes(input.runtimeMessages),
  };
}

export type ConversationRenderContext = ReturnType<typeof conversationRenderContext>;
export interface RenderErrorReport {
  readonly scope: string;
  readonly error: SerializedRenderError;
  readonly componentStack: string;
  readonly context?: ConversationRenderContext;
  readonly contextError?: SerializedRenderError;
}

export function renderErrorReport(
  scope: string,
  error: unknown,
  componentStack: string | null | undefined,
  getContext?: () => ConversationRenderContext,
): RenderErrorReport {
  let context: ConversationRenderContext | undefined;
  let contextError: SerializedRenderError | undefined;
  try { context = getContext?.(); } catch (failure) { contextError = serializeRenderError(failure); }
  return {
    scope: bounded(scope, 80),
    error: serializeRenderError(error),
    componentStack: bounded(componentStack ?? "", 8_000),
    ...(context ? { context } : {}),
    ...(contextError ? { contextError } : {}),
  };
}
