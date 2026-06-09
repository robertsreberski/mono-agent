import {
  bearerTokensEqual,
  generateBearerToken,
  readAuthorizationBearer,
} from "@worklab-ai/settings";

/**
 * 32-byte random hex token for per-boot bearer auth. Delegates to the shared
 * {@link generateBearerToken} so every bearer-protected surface mints tokens
 * the same way.
 */
export function generateToken(): string {
  return generateBearerToken();
}

/**
 * Constant-time string comparison. Returns false for length mismatches
 * (length is not secret in this protocol, so leaking it via early exit
 * is acceptable). Delegates to the shared {@link bearerTokensEqual}.
 */
export function tokensEqual(a: string, b: string): boolean {
  return bearerTokensEqual(a, b);
}

/**
 * Extract the bearer token from a request. Accepts both the Authorization
 * header and a `t` query parameter (the latter exists only so the human can
 * open the URL in their browser; the SPA strips it from location after load).
 *
 * The Authorization-header parsing is delegated to the shared
 * {@link readAuthorizationBearer}; the `?t=` query fallback is operator-console
 * specific and stays here.
 */
export function readBearerToken(
  headers: Record<string, string | string[] | undefined>,
  url: string,
): string | undefined {
  const raw = headers["authorization"] ?? headers["Authorization"];
  const auth = typeof raw === "string" ? raw : undefined;
  const fromHeader = readAuthorizationBearer(auth);
  if (fromHeader !== undefined) {
    return fromHeader;
  }
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return undefined;
  }
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const t = params.get("t");
  return t ?? undefined;
}
