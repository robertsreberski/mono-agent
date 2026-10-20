import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from "@earendil-works/pi-ai";

export const BACKOFF_ABORT = Symbol("mono-pi-backoff-abort");

function backoff(ms: any, signal: any): Promise<any> {
  return new Promise((resolve: (value: any) => void, reject: (reason?: any) => void) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(undefined); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pi's retryAssistantCall shape, plus a host predicate. `policy.shouldRetry`
 * receives the failed message and whether that attempt's response started
 * (the provider emitted `start`); the default keeps Pi's classifier.
 */
async function retryRequest(produce: any, policy: any, signal: any, callbacks: any): Promise<any> {
  const maxRetries = policy?.enabled ? policy.maxRetries : 0;
  const shouldRetry = typeof policy?.shouldRetry === "function" ? policy.shouldRetry
    : (message: any) => isRetryableAssistantError(message);
  let retries = 0;
  for (;;) {
    const { response, responseStarted } = await produce();
    if (response.stopReason === "aborted" || response.stopReason !== "error"
      || retries >= maxRetries || !shouldRetry(response, { responseStarted, retries })) {
      if (retries > 0) await callbacks.onRetryFinished(response.stopReason !== "error" && response.stopReason !== "aborted",
        retries, response.stopReason === "error" ? response.errorMessage : undefined);
      return response;
    }
    retries += 1;
    const errorMessage = response.errorMessage || "Unknown error";
    const delayMs = Math.min(policy.baseDelayMs * 2 ** (retries - 1), policy.maxDelayMs ?? 60_000);
    await callbacks.onRetryScheduled(retries, maxRetries, delayMs, errorMessage);
    try { await backoff(delayMs, signal); } catch {
      // Normalize an aborted backoff to the provider-abort message shape.
      await callbacks.onRetryFinished(false, retries, errorMessage);
      const { errorMessage: _discarded, ...rest } = response;
      return { ...rest, stopReason: "aborted" };
    }
    await callbacks.onRetryAttemptStart();
  }
}

// Single-item, acknowledged channel: retry callbacks cannot overtake streamed
// deltas. The loop acknowledges a yielded event only after its awaited sink ran.
function eventChannel(onClose: any): { push(value: any): Promise<void>; end(error?: any): void; cancel(): void; [Symbol.asyncIterator](): AsyncGenerator<any, void, unknown>; } {
  let item: any, wake: any, failure: any;
  let ended = false;
  return {
    async push(value: any): Promise<void> {
      if (ended) throw new Error("Retry stream consumer closed");
      await new Promise((ack: (value: any) => void) => { item = { value, ack }; wake?.(); });
    },
    end(error?: any): void { ended = true; failure = error; wake?.(); },
    cancel(): void { ended = true; item?.ack(); item = undefined; wake?.(); onClose(); },
    async *[Symbol.asyncIterator](): AsyncGenerator<any, void, unknown> {
      while (true) {
        if (!item && !ended) await new Promise((r: (value: any) => void) => { wake = r; });
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
export function createRetryStream(models: any, model: any, context: any, options: any, policy: any, emit: any): {
    [Symbol.asyncIterator]: () => {
        [Symbol.asyncIterator](): /*elided*/ any;
        next: () => Promise<IteratorResult<any, void>>;
        return: () => Promise<IteratorResult<any, void>>;
        throw: (error: any) => Promise<IteratorResult<any, void>>;
    };
    result: () => Promise<any>;
} {
  // The old harness re-resolved identity through Models before dispatch and
  // classification. Host policy metadata may differ from the transport catalog;
  // use the same facade (including probe caps/context-1M) as the actual request.
  const requestModel = models.getModel(model.provider, model.id);
  if (!requestModel) throw new Error("Configured Pi model is unavailable");
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let consumerClosed = false;
  const assertConsumerOpen = () => { if (consumerClosed) throw new Error("Retry stream consumer closed"); };
  const emitIfOpen = (event: any) => { assertConsumerOpen(); return emit(event); };
  const channel = eventChannel(() => { consumerClosed = true; controller.abort(); });
  let resolveResult = (_value: any) => {}, rejectResult = (_error: any) => {};
  const result = new Promise((resolve: (value: any) => void, reject: (reason?: any) => void) => { resolveResult = resolve; rejectResult = reject; });
  // The iterator carries errors too; don't manufacture an unhandled rejection
  // when a caller exits through the iterator rather than calling result().
  void result.catch(() => {});
  let last: any;
  let ordinal = 0, hasStart = false;
  void (async () => {
    try {
      const final = await retryRequest(async () => {
        assertConsumerOpen();
        // Each attempt re-sends the same request context: the failed partial is
        // journaled (and billed) through message_end, never projected into it.
        const stream = await models.streamSimple(requestModel, context, { ...options, signal: controller.signal });
        ordinal += 1;
        let responseStarted = false;
        for await (const event of stream) {
          if (event.type === "done" || event.type === "error") continue;
          if (event.type === "start") {
            responseStarted = true;
            if (!hasStart) { hasStart = true; await channel.push(event); }
            else await emitIfOpen({ type: "message_start", message: event.partial });
          } else await channel.push(event);
        }
        last = await stream.result();
        assertConsumerOpen();
        // The removed harness classified silent overflow and a premature length
        // stop before tool dispatch/settlement. The low-level loop does not: a
        // length response without calls is otherwise a successful final answer.
        // Keep the original model cap (before provider context clamping), usage
        // and content, and leave real provider errors/cancellation unchanged.
        if (last.stopReason !== "error" && (isContextOverflow(last, requestModel.contextWindow)
          || isRecoverableLength(last, requestModel.maxTokens))) {
          last = { ...last, stopReason: "error", errorMessage: last.errorMessage ?? "Assistant request exceeded the context window" };
        }
        return { response: last, responseStarted };
      }, policy, controller.signal, {
        onRetryScheduled: async (attempt: any, maxRetries: any, delayMs: any, errorMessage: any) => {
          assertConsumerOpen();
          // Old harness persisted and billed failed attempts, but did not emit
          // turn_end until a request settled. Keep that stream/accounting shape.
          if (!hasStart) { hasStart = true; await channel.push({ type: "start", partial: last }); }
          await emitIfOpen({ type: "message_end", message: last });
          await emitIfOpen({ type: "retry_scheduled", attempt: attempt + 1, maxAttempts: maxRetries + 1, delayMs, errorMessage });
        },
        onRetryAttemptStart: () => emitIfOpen({ type: "retry_start", attempt: ordinal + 1 }),
        onRetryFinished: (success: any, attempt: any, finalError: any) => emitIfOpen({ type: "retry_end", success, attempt: attempt + 1, finalError }),
      });
      if (final.stopReason === "aborted" && last?.stopReason === "error") {
        Object.defineProperty(final, BACKOFF_ABORT, { value: true });
      }
      assertConsumerOpen();
      resolveResult(final);
      await channel.push(final.stopReason === "error" || final.stopReason === "aborted"
        ? { type: "error", reason: final.stopReason, error: final }
        : { type: "done", reason: final.stopReason, message: final });
      channel.end();
    } catch (error) { rejectResult(error); channel.end(error); }
    finally { options.signal?.removeEventListener("abort", abort); }
  })();
  return { [Symbol.asyncIterator]: () => {
    const iterator = channel[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator](): { [Symbol.asyncIterator](): any; next: () => Promise<IteratorResult<any, void>>; return: () => Promise<IteratorResult<any, void>>; throw: (error: any) => Promise<IteratorResult<any, void>>; } { return this; }, next: () => iterator.next(),
      return: async () => { channel.cancel(); return iterator.return(undefined); },
      throw: async (error: any) => { channel.cancel(); return iterator.throw(error); },
    };
  }, result: () => result };
}
