import { createHash } from "node:crypto";

/** Probe only the credential actually selected for dispatch. No file reads,
 * refresh, writes or paid requests. Pi 1.0.1 Codex login AND refresh expose
 * accountId from the access-token auth claim. Neither token hashes nor auth
 * paths prove an account. Unsupported credentials return explicit unknown.
 * @param {{provider:string, api:string, credential:any, dispatchApiKey:string}} input
 */
export function probeNativeAccountProvenance(input) {
  const unknown = { supported: false, reason: "account_not_established" };
  const credential = input?.credential;
  if (input?.provider !== "openai-codex" || !input.api || credential?.type !== "oauth"
    || typeof credential.accountId !== "string" || !credential.accountId.trim() || credential.accountId === "unknown"
    || typeof credential.access !== "string" || credential.access !== input.dispatchApiKey) return unknown;
  try {
    const parts = credential.access.split(".");
    if (parts.length !== 3) return unknown;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims?.["https://api.openai.com/auth"]?.chatgpt_account_id !== credential.accountId) return unknown;
    return { supported: true, provenance: { provider: input.provider, api: input.api,
      account: `codex-account-v1:${createHash("sha256").update("mono-harness/codex-account/v1\0").update(credential.accountId).digest("hex")}` } };
  } catch { return unknown; }
}
