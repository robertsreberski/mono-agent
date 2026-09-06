import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_AUTH_INPUT_BYTES,
  parseProviderAuthSessionInput,
  parseProviderAuthSessionSnapshot,
  parseProviderAuthStatusSnapshot,
} from "../provider-auth.js";

const status = () => ({
  schema: "mono-agent.provider-auth.v1",
  generatedAt: "2026-09-06T12:00:00.000Z",
  providers: [{
    providerId: "openai-codex",
    label: "OpenAI Codex",
    usages: [{ kind: "primary", model: "openai-codex:gpt-5.6", label: "Primary" }],
    state: "expired",
    credentialType: "oauth",
    source: "stored",
    expiresAt: "2026-09-06T11:00:00.000Z",
    verification: "not_verified",
    methods: [{ authType: "oauth", strategy: "device_code", label: "Device code", recommended: true }],
    lastFailure: {
      kind: "provider_auth",
      message: "Provider rejected the configured credential.",
      model: "openai-codex:gpt-5.6",
      observedAt: "2026-09-06T11:30:00.000Z",
    },
  }],
});

const session = () => ({
  schema: "mono-agent.provider-auth-session.v1",
  id: "session-one",
  providerId: "openai-codex",
  authType: "oauth",
  strategy: "device_code",
  state: "awaiting_user",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:00:01.000Z",
  expiresAt: "2026-09-06T12:20:00.000Z",
  deviceCode: {
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-09-06T12:15:00.000Z",
  },
});

describe("provider auth contracts", () => {
  it("strictly parses bounded status and session snapshots", () => {
    expect(parseProviderAuthStatusSnapshot(status())).toEqual(status());
    expect(parseProviderAuthSessionSnapshot(session())).toEqual(session());
  });

  it("rejects unknown fields and non-http auth URLs", () => {
    expect(() => parseProviderAuthStatusSnapshot({ ...status(), secret: "no" })).toThrow(/Invalid provider auth status/u);
    expect(() => parseProviderAuthSessionSnapshot({
      ...session(),
      deviceCode: { ...session().deviceCode, verificationUri: "javascript:alert(1)" },
    })).toThrow(/Invalid provider device code/u);
  });

  it("accepts a secret input without echoing it through a projection", () => {
    const value = "sentinel-provider-secret";
    expect(parseProviderAuthSessionInput({ promptId: "prompt-one", value })).toEqual({ promptId: "prompt-one", value });
    expect(JSON.stringify(session())).not.toContain(value);
    expect(JSON.stringify(status())).not.toContain(value);
    expect(parseProviderAuthSessionInput({ promptId: "prompt-one", value: "" })).toEqual({ promptId: "prompt-one", value: "" });
  });

  it("rejects NUL and oversized input", () => {
    expect(() => parseProviderAuthSessionInput({ promptId: "p", value: "a\0b" })).toThrow(/invalid or too large/u);
    expect(() => parseProviderAuthSessionInput({ promptId: "p", value: "x".repeat(MAX_PROVIDER_AUTH_INPUT_BYTES + 1) }))
      .toThrow(/invalid or too large/u);
  });
});
