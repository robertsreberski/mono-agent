import { expect, it, vi } from "vitest";
import { buildRunModels } from "../../execution/pi/run.js";
import type { PiOptions, PiRuntime } from "../../execution/pi/types.js";

it("decorates normally credentialed Models, preserving credential reads and receiver", async () => {
  const readCredential = vi.fn(async () => ({ type: "api_key" as const, key: "FAKE-TEST-KEY-NOT-REAL" }));
  const resolver = Object.assign(async () => "FAKE-TEST-KEY-NOT-REAL", { readCredential });
  const decorator = vi.fn(models => new Proxy(models, { get(target, key) {
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }));
  const models = buildRunModels({ apiKeys: new Map() } as PiRuntime, { resolvePiApiKey: resolver, piModelsDecorator: decorator }, []);
  expect(decorator).toHaveBeenCalledOnce();
  const model = models.getModel("openai", "gpt-4.1")!;
  expect(await models.getAuth(model)).toBeTruthy();
  expect(readCredential).toHaveBeenCalledWith("openai");
});
it("refuses combining the decorator and verbatim Models seams before decoration", () => {
  const decorator = vi.fn(models => models);
  expect(() => buildRunModels({} as PiRuntime, { piResolvedModels: {} as never, piModelsDecorator: decorator } as PiOptions, []))
    .toThrow("pi_models_seams_mutually_exclusive");
  expect(decorator).not.toHaveBeenCalled();
});
