import { describe, it, expect } from "vitest";
import { backendCapabilities, backendUsesExecenvConfig, backendSupportsSessionResume, BACKEND_CAPABILITIES } from "../../ai/backend.js";
import { PROVIDER_KIND_VALUES } from "../../ai/types.js";

describe("backendCapabilities", () => {
  it("resolves by sdk kind", () => {
    expect(backendCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
    expect(backendCapabilities("pi")).toMatchObject({ kind: "pi", runtime: "pi-agent" });
    expect(backendCapabilities("codex")).toMatchObject({ kind: "codex", runtime: "cli" });
    expect(backendCapabilities("opencode")).toMatchObject({ kind: "opencode", runtime: "cli" });
  });

  it("resolves by parsed model object", () => {
    expect(backendCapabilities({ sdk: "pi", provider: "openai", model: "gpt-5.5" }).kind).toBe("pi");
  });

  it("throws on unknown or reserved sdk", () => {
    expect(() => backendCapabilities("nope")).toThrow();
    expect(() => backendCapabilities("claude-code")).toThrow(/unknown provider sdk/i);
  });
});

describe("backendUsesExecenvConfig", () => {
  it("registered backends do not need native runtime config files", () => {
    expect(backendUsesExecenvConfig("claude")).toBe(false);
    expect(backendUsesExecenvConfig("pi")).toBe(false);
    expect(backendUsesExecenvConfig("codex")).toBe(false);
    expect(backendUsesExecenvConfig("opencode")).toBe(false);
  });
});

describe("backendSupportsSessionResume", () => {
  it("claims session resume for every registered provider", () => {
    expect(backendSupportsSessionResume("claude")).toBe(true);
    expect(backendSupportsSessionResume("pi")).toBe(true);
    expect(backendSupportsSessionResume("codex")).toBe(true);
    expect(backendSupportsSessionResume("opencode")).toBe(false);
  });
});

describe("BACKEND_CAPABILITIES", () => {
  it("covers every PROVIDER_KIND", () => {
    expect(Object.keys(BACKEND_CAPABILITIES).sort()).toEqual(
      [...PROVIDER_KIND_VALUES].sort(),
    );
  });
});
