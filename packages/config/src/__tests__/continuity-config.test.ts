import { describe, expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";
import { redactMonoAgentConfig } from "../redact.js";
import { buildMonoAgentConfigView } from "../config-view.js";

const resolve = (continuity?: unknown, session = {}) => resolveJsonMonoAgentConfig({
  cwd: "/home/example", json: {
    runtime: { model: "openai-codex:gpt-5.5", session: { ...session, ...(continuity === undefined ? {} : { continuity }) } },
    context: { identityPath: "IDENTITY.md" },
  } as never,
});

describe("continuity configuration", () => {
  it("defaults on through absence while preserving an explicit false opt-out", () => {
    expect(JSON.stringify(resolve({}))).toBe(JSON.stringify(resolve()));
    expect(resolve().runtime.session.continuity?.enabled ?? true).toBe(true);
    expect(resolve({ enabled: false }).runtime.session.continuity).toEqual({ enabled: false });
  });
  it("enables independently of memory, provider-session persistence or session mode", () => {
    expect(resolve({ enabled: true }).runtime.session.continuity).toEqual({ enabled: true });
    expect(resolve({ enabled: true }, { mode: "per-message" }).runtime.session.continuity).toEqual({ enabled: true });
    expect(resolve({ enabled: true }).memory).toBeUndefined();
  });
  it.each([null, [], true, "true", { enabled: "true" }, { enabled: null }, { enabled: 1 }])("rejects malformed configuration %j", (value) => {
    expect(() => resolve(value)).toThrow(/runtime.session.continuity/u);
  });
  it("projects the enabled field into the resolved view with JSON provenance", () => {
    const config = resolve({ enabled: true });
    const view = buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(config), json: { runtime: { session: { continuity: { enabled: true } } } } });
    const fields = view.flatMap((s) => s.fields);
    expect(fields.find((f) => f.id === "runtime.session.continuity.enabled")).toMatchObject({ value: "yes", source: "json" });
    const defaults = buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(resolve()), json: {} });
    expect(defaults.flatMap((s) => s.fields).find((f) => f.id === "runtime.session.continuity.enabled")).toMatchObject({ value: "yes", source: "default" });
  });
});

it("rejects typo continuity keys rather than enabling an irreversible migration", () => {
  expect(() => resolve({ enable: false })).toThrow("supports only enabled");
});
