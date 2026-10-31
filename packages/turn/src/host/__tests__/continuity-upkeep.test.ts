import { expect, it, vi } from "vitest";
import { createMonoRuntime } from "../create-runtime.js";

const model = { provider: "fictional", model: "primary", reference: "fictional:primary" };
const options = () => ({ model, messages: [], abortSignal: new AbortController().signal });

it("skips resource-owning attempt resolvers and releases their preflight resources", async () => {
  const cleanup = vi.fn(), prepare = vi.fn();
  const resolveAttempt = vi.fn(() => ({ cleanup, runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare } }));
  const runtime = createMonoRuntime({ fallbackChain: [{ model }, { model: { ...model, model: "backup", reference: "fictional:backup" } }], resolveAttempt });
  expect(await runtime.prepareContinuityUpkeep!(options())).toBeUndefined();
  expect(resolveAttempt).toHaveBeenCalledOnce();
  expect(resolveAttempt).toHaveBeenCalledWith({ model, attemptIndex: 0, retryIndex: 0 });
  expect(cleanup).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled();
});

it("delegates only selected inference inputs, leaving host callbacks as overridable defaults", async () => {
  const hostAuth = vi.fn(), hostPricing = vi.fn();
  const prepare = vi.fn(async () => undefined);
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolvePiApiKey: hostAuth, resolveCustomPricing: hostPricing,
    resolveAttempt: () => ({ runtime: { run: vi.fn(), prepareContinuityUpkeep: prepare }, options: { customModel: { id: "primary" }, mcpServers: { forbidden: {} } } }) });
  const request = options();
  await runtime.prepareContinuityUpkeep!({ ...request, mcpServers: { forbidden: {} }, sessionId: "fictional-session", allowedTools: ["Exec"] }, { requireRequestCap: true });
  expect(prepare).toHaveBeenCalledWith({ ...request, customModel: { id: "primary" } }, {
    defaults: { resolvePiApiKey: hostAuth, resolveCustomPricing: hostPricing }, requireRequestCap: true,
  });
  expect(hostAuth).not.toHaveBeenCalled(); expect(hostPricing).not.toHaveBeenCalled();
});

it("does not substitute another runtime when the selected custom route lacks preflight", async () => {
  const run = vi.fn();
  const runtime = createMonoRuntime({ fallbackChain: [{ model }], resolveAttempt: () => ({ runtime: { run } }) });
  expect(await runtime.prepareContinuityUpkeep!(options())).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});
