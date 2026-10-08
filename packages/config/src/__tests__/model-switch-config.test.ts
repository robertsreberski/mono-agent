import { expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";

const resolve = (modelSwitch?: unknown, session = {}, providers: unknown = { piNative: { piSessionsRoot: "native" } }) => resolveJsonMonoAgentConfig({
  cwd: "/fictional", json: { runtime: { model: "pi:openai-codex:gpt-5.5", session: { ...session, ...(modelSwitch === undefined ? {} : { modelSwitch }) } },
    context: { identityPath: "IDENTITY.md" }, providers } as never,
});
it("keeps absent and explicit OFF resolved config byte-identical", () => {
  expect(JSON.stringify(resolve({ enabled: false }))).toBe(JSON.stringify(resolve()));
  expect(JSON.stringify(resolve({}))).toBe(JSON.stringify(resolve()));
});
it("requires a distinct explicit stopped-writer acknowledgement", () => {
  expect(resolve({ enabled: true, olderWritersStopped: true }).runtime.session.modelSwitch).toEqual({ enabled: true, olderWritersStopped: true });
  for (const value of [{ enabled: true }, { enabled: true, olderWritersStopped: false }, { enabled: true, olderWritersStopped: "true" }, { enabled: "true", olderWritersStopped: true }, null, []]) {
    expect(() => resolve(value)).toThrow();
  }
  expect(() => resolve({ enabled: true, olderWritersStopped: true }, { mode: "per-message" })).toThrow("continuous");
  expect(() => resolve({ enabled: true, olderWritersStopped: true }, {}, {})).toThrow("durable Pi");
});
