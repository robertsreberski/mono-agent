import { expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";

const resolve = (modelSwitch?: unknown, session = {}) => resolveJsonMonoAgentConfig({
  cwd: "/fictional", json: { runtime: { model: "pi:openai-codex:gpt-5.5", session: { root: "native", ...session, ...(modelSwitch === undefined ? {} : { modelSwitch }) } },
    context: { identityPath: "IDENTITY.md" } } as never,
});
it("keeps absent and explicit OFF resolved config byte-identical", () => {
  expect(JSON.stringify(resolve({ enabled: false }))).toBe(JSON.stringify(resolve()));
  expect(JSON.stringify(resolve({}))).toBe(JSON.stringify(resolve()));
});
it("enables switching without an acknowledgement, with continuous durable sessions", () => {
  expect(resolve({ enabled: true }).runtime.session.modelSwitch).toEqual({ enabled: true });
  for (const value of [{ enabled: "true" }, null, []]) expect(() => resolve(value)).toThrow();
  expect(() => resolve({ enabled: true }, { mode: "per-message" })).toThrow("continuous");
  expect(() => resolve({ enabled: true }, { root: undefined })).toThrow("runtime.session.root");
});

it("rejects the old config key with exact replacement guidance, even alongside the new key", () => {
  for (const value of ["old", null, ""]) expect(() => resolveJsonMonoAgentConfig({
    cwd: "/fictional", json: { runtime: { model: "pi:openai-codex:gpt-5.5", session: { root: "new" } },
      context: { identityPath: "IDENTITY.md" }, providers: { piNative: { piSessionsRoot: value } } } as never,
  })).toThrow("providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there");
});
it("resolves runtime.session.root relative to the agent root", () => {
  expect(resolve(undefined, { root: "./sessions" }).runtime.session.root).toBe("/fictional/sessions");
});
