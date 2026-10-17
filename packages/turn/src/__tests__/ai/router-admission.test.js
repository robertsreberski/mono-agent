import { expect, it, vi } from "vitest";
import { createRouterRuntime } from "../../runtime/router.js";

it.each([false, true])("reports cancellation without failover when aborted during detached context loading (throws=%s)", async (throws) => {
  const primary = { provider: "openai-codex", model: "fictional-primary", reference: "openai-codex:fictional-primary" };
  const backup = { provider: "anthropic", model: "fictional-backup", reference: "anthropic:fictional-backup" };
  const controller = new AbortController(), events = [];
  const primaryRun = vi.fn(async () => ({ error: "Connection error.", failureKind: "provider_unavailable", events: [] }));
  const backupRun = vi.fn(async () => ({ text: "Fictional backup answer", events: [] })), cleanup = vi.fn();
  const loader = vi.fn(async () => {
    await Promise.resolve();
    controller.abort(new Error("Fictional cancellation during history load"));
    if (throws) throw controller.signal.reason;
    return [{ role: "user", content: "Fictional earlier history" }];
  });
  const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: ({ attemptIndex }) => ({
    // @ts-expect-error Deliberately partial route double; only dispatch is exercised.
    runtime: { configureTools() {}, run: attemptIndex === 0 ? primaryRun : backupRun },
    ...(attemptIndex === 1 ? { cleanup } : {}),
  }) });
  const result = await router.run("Fictional instructions", {
    model: primary, messages: [{ role: "user", content: "Fictional current request" }],
    abortSignal: controller.signal, detachedContext: loader, onEvent: (event) => events.push(event),
  });
  expect(result.cancelled).toBe(true);
  expect(loader).toHaveBeenCalledOnce(); expect(primaryRun).toHaveBeenCalledOnce();
  expect(backupRun).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === "provider_failover_started" || event.warning_kind === "detached_context_unavailable")).toEqual([]);
});
