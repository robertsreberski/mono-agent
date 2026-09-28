import type { ProviderAuthCheckResult, ProviderAuthCheckSessionSnapshot, ProviderAuthProviderStatus, ProviderAuthSessionSnapshot } from "../../types";

export function terminal(state: ProviderAuthSessionSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function checkTerminal(state: ProviderAuthCheckSessionSnapshot["state"]): boolean {
  return state === "completed" || state === "cancelled";
}

export function providerAuthPresentation(provider: ProviderAuthProviderStatus): {
  readonly className: string;
  readonly glyph: string;
  readonly label: string;
} {
  if (provider.lastFailure?.kind === "provider_auth") {
    return { className: "is-needs-action", glyph: "⚠", label: "Needs action" };
  }
  if (provider.state === "not_applicable") {
    return { className: "is-not-applicable", glyph: "–", label: "Not applicable" };
  }
  if (provider.state !== "present") {
    return { className: "is-needs-action", glyph: "⚠", label: "Needs action" };
  }
  if (provider.verification === "verified_by_live_request" && provider.lastFailure === undefined) {
    return { className: "is-ok", glyph: "✓", label: "OK" };
  }
  if (provider.verification === "verified_by_account_request" && provider.lastFailure === undefined) {
    return { className: "is-ok-account", glyph: "✓", label: "Credential OK" };
  }
  return { className: "is-not-verified", glyph: "?", label: "Not verified" };
}

export function providerAuthCheckPresentation(result: ProviderAuthCheckResult): {
  readonly className: string;
  readonly label: string;
} {
  switch (result.state) {
    case "pending": return { className: "is-neutral", label: "Pending" };
    case "running": return { className: "is-neutral", label: "Checking…" };
    case "passed": return { className: "is-passed", label: "Check passed" };
    case "auth_failed": return { className: "is-failed", label: "Auth failed" };
    case "network_failed": return { className: "is-neutral", label: "Network error" };
    case "quota_limited": return { className: "is-neutral", label: "Quota blocked" };
    case "model_not_entitled": return { className: "is-neutral", label: "Model unavailable" };
    case "inconclusive": return { className: "is-neutral", label: "Inconclusive" };
    case "unsupported": return { className: "is-neutral", label: "Not checked" };
    case "timeout": return { className: "is-neutral", label: "Timed out" };
    case "cancelled": return { className: "is-neutral", label: "Cancelled" };
    case "stale": return { className: "is-neutral", label: "Credential changed" };
    case "not_run": return { className: "is-neutral", label: "Not run" };
  }
}

export function providerAuthCheckSummary(check: ProviderAuthCheckSessionSnapshot): string {
  const finished = check.results.filter((result) => result.state !== "pending" && result.state !== "running").length;
  if (!checkTerminal(check.state)) return `Checking providers: ${finished} of ${check.results.length} complete.`;
  const passed = check.results.filter((result) => result.state === "passed").length;
  return `Checks complete: ${passed} of ${check.results.length} passed.`;
}

export function providerAuthResourceAbsent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && "code" in error
    && (error as { readonly status?: unknown }).status === 404
    && (error as { readonly code?: unknown }).code === "provider_auth_not_found";
}
