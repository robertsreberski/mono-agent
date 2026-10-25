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

it.each([true, false])("resolves packEnabled=%s independently, including disabled capture", packEnabled => {
  expect(resolve({ packEnabled }).runtime.session.continuity).toEqual({ enabled: true, packEnabled });
  expect(resolve({ enabled: false, packEnabled }).runtime.session.continuity).toEqual({ enabled: false, packEnabled });
  const view = buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(resolve({ packEnabled })), json: { runtime: { session: { continuity: { packEnabled } } } } });
  expect(view.flatMap(s => s.fields).find(f => f.id === "runtime.session.continuity.packEnabled")).toMatchObject({ value: packEnabled ? "yes" : "no", source: "json" });
});
it.each([null, 1, "false"])("rejects invalid packEnabled=%j", packEnabled => {
  expect(() => resolve({ packEnabled })).toThrow(/runtime.session.continuity.packEnabled/);
});

it("keeps ledger and upkeep off by default and resolves an explicit model/strict override", () => {
  expect(resolve().runtime.session.continuity?.upkeep?.enabled ?? false).toBe(false);
  expect(resolve().runtime.session.continuity?.ledgerEnabled ?? false).toBe(false);
  expect(resolve({ upkeep: { enabled: true } }).runtime.session.continuity?.upkeep).toEqual({ enabled: true, requireRequestCap: false });
  const config = resolve({ ledgerEnabled: true, upkeep: { enabled: true, requireRequestCap: true, extractionModel: "openai:gpt-4o-mini" } });
  expect(config.runtime.session.continuity?.upkeep).toMatchObject({ enabled: true, requireRequestCap: true, extractionModel: { provider: "openai", model: "gpt-4o-mini" } });
});
it.each([{ enabled: "true" }, { requireRequestCap: 1 }, { extractionModel: false }, { unknown: true }, null])("rejects invalid upkeep %j", upkeep => {
  expect(() => resolve({ upkeep })).toThrow();
});

it("reports upkeep model/unknown-key errors as repairable config errors with paths", () => {
  expect(() => resolve({ upkeep: { extractionModel: "not-a-reference" } })).toThrow(expect.objectContaining({ code: "invalid_model_reference", details: expect.objectContaining({ path: "runtime.session.continuity.upkeep.extractionModel" }) }));
  expect(() => resolve({ upkeep: { unexpected: true } })).toThrow(expect.objectContaining({ code: "invalid_json", details: expect.objectContaining({ path: "runtime.session.continuity.upkeep" }) }));
});
