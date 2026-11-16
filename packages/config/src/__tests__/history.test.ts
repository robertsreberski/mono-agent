import { expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";
import type { MonoAgentConfigJson } from "../json-types.js";

const config = (history?: unknown) => resolveJsonMonoAgentConfig({ cwd: "/fictional-agent", json: { context: { identityPath: "IDENTITY.md" }, runtime: { model: "openai-codex:gpt-5.5" }, tools: history === undefined ? {} : { history } } as MonoAgentConfigJson });
it("keeps default and explicit false resolved config byte-identical", () => {
  expect(JSON.stringify(config())).toBe(JSON.stringify(config({ unified: false })));
  expect(config().tools.history).toBeUndefined();
  expect(config({ unified: true }).tools.history).toEqual({ unified: true });
});
it.each([null, true, [], "yes", { unified: "true" }, { unified: 1 }, { other: true }])("rejects invalid history config %j", history => {
  expect(() => config(history)).toThrow();
});
