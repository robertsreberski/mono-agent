import { retryAssistantCall } from "@earendil-works/pi-ai";

export const BACKOFF_ABORT = Symbol("mono-pi-backoff-abort");

// Single-item, acknowledged channel: retry callbacks cannot overtake streamed
// deltas. The loop acknowledges a yielded event only after its awaited sink ran.
function eventChannel() {
  let item, wake, failure;
  let ended = false;
  return {
    async push(value) {
      await new Promise((ack) => { item = { value, ack }; wake?.(); });
    },
    end(error) { ended = true; failure = error; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (!item && !ended) await new Promise((r) => { wake = r; });
        if (item) {
          const next = item; item = undefined;
          try { yield next.value; } finally { next.ack(); }
        } else if (failure) throw failure;
        else if (ended) return;
      }
    },
  };
}

/** Retry one conversational provider request, not tools or the whole agent run. */
export function createRetryStream(models, model, context, options, policy, emit) {
  const channel = eventChannel();
  let resolveResult = (_value) => {}, rejectResult = (_error) => {};
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // The iterator carries errors too; don't manufacture an unhandled rejection
  // when a caller exits through the iterator rather than calling result().
  void result.catch(() => {});
  /** @type {any} */
  let last;
  let ordinal = 0, hasStart = false;
  void (async () => {
    try {
      const final = await retryAssistantCall(async () => {
        const stream = await models.streamSimple(model, context, options);
        ordinal += 1;
        for await (const event of stream) {
          if (event.type === "done" || event.type === "error") continue;
          if (event.type === "start") {
            if (!hasStart) { hasStart = true; await channel.push(event); }
            else await emit({ type: "message_start", message: event.partial });
          } else await channel.push(event);
        }
        last = await stream.result();
        return last;
      }, policy, options.signal, {
        onRetryScheduled: async (attempt, maxRetries, delayMs, errorMessage) => {
          // Old harness persisted and billed failed attempts, but did not emit
          // turn_end until a request settled. Keep that stream/accounting shape.
          if (!hasStart) { hasStart = true; await channel.push({ type: "start", partial: last }); }
          await emit({ type: "message_end", message: last });
          await emit({ type: "retry_scheduled", attempt: attempt + 1, maxAttempts: maxRetries + 1, delayMs, errorMessage });
        },
        onRetryAttemptStart: () => emit({ type: "retry_start", attempt: ordinal + 1 }),
        onRetryFinished: (success, attempt, finalError) => emit({ type: "retry_end", success, attempt: attempt + 1, finalError }),
      });
      if (final.stopReason === "aborted" && last?.stopReason === "error") {
        Object.defineProperty(final, BACKOFF_ABORT, { value: true });
      }
      resolveResult(final);
      await channel.push(final.stopReason === "error" || final.stopReason === "aborted"
        ? { type: "error", reason: final.stopReason, error: final }
        : { type: "done", reason: final.stopReason, message: final });
      channel.end();
    } catch (error) { rejectResult(error); channel.end(error); }
  })();
  return { [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](), result: () => result };
}
