import { describe, expect, it } from "vitest";
import type { ProviderAuthProviderStatus, ProviderAuthStatusSnapshot } from "../../types";
import { providerAuthPresentation, providersSummary } from "./provider-auth-presentation";

const provider = (state: ProviderAuthProviderStatus["state"], verification: ProviderAuthProviderStatus["verification"]): ProviderAuthProviderStatus => ({
  providerId: "example", label: "Example Cloud", state, verification, usages: [], methods: [],
});
const snapshot = (...providers: ProviderAuthProviderStatus[]): ProviderAuthStatusSnapshot => ({ schema: "mono-agent.provider-auth.v1", generatedAt: "2026-01-01T00:00:00Z", providers });

describe("provider status presentation", () => {
  it("distinguishes a live check, credential check, unverified credential and not applicable", () => {
    expect(providerAuthPresentation(provider("present", "verified_by_live_request")).label).toBe("OK");
    expect(providerAuthPresentation(provider("present", "verified_by_account_request")).label).toBe("Credential OK");
    expect(providerAuthPresentation(provider("present", "not_verified")).label).toBe("Not verified");
    expect(providerAuthPresentation(provider("not_applicable", "not_verified")).label).toBe("Not applicable");
  });
  it("prioritizes needs-action over unverified and never reports no-action as a verified connection", () => {
    expect(providersSummary(null)).toBe("Loading provider status…");
    expect(providersSummary(snapshot(provider("not_applicable", "not_verified")))).toBe("No action needed");
    expect(providersSummary(snapshot(provider("present", "verified_by_live_request"), provider("present", "verified_by_account_request")))).toBe("No action needed");
    expect(providersSummary(snapshot(provider("present", "verified_by_live_request"), provider("present", "not_verified")))).toBe("1 not verified");
    expect(providersSummary(snapshot(provider("present", "not_verified"), provider("missing", "not_verified")))).toBe("1 needs action");
    expect(providersSummary(snapshot(provider("missing", "not_verified"), provider("missing", "not_verified")))).toBe("2 needs action");
    expect(providersSummary(snapshot(provider("not_applicable", "not_verified")))).not.toMatch(/connected|verified/u);
  });
});
