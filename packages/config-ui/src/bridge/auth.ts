import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 32-byte random hex token for per-boot bearer auth.
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time string comparison. Returns false for length mismatches
 * (length is not secret in this protocol, so leaking it via early exit
 * is acceptable).
 */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Extract the bearer token from a request. Accepts both the Authorization
 * header and a `t` query parameter (the latter exists only so the human can
 * open the URL in their browser; the SPA strips it from location after load).
 */
export function readBearerToken(
  headers: Record<string, string | string[] | undefined>,
  url: string,
): string | undefined {
  const auth = headers["authorization"] ?? headers["Authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return undefined;
  }
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const t = params.get("t");
  return t ?? undefined;
}
