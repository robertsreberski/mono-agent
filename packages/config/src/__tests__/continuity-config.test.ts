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
  it("keeps absent, empty and explicit OFF resolved configuration byte-identical", () => {
    expect(JSON.stringify(resolve({ enabled: false }))).toBe(JSON.stringify(resolve()));
    expect(JSON.stringify(resolve({}))).toBe(JSON.stringify(resolve()));
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
  });
});
