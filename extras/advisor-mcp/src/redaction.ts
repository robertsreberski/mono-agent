import type { AdvisorReviewResponse } from "./protocol.js";

const REDACTED_SECRET = "[REDACTED]";
const REDACTED_PATH = "<private-path>";

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
  /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/giu,
  /\b(?:export\s+)?(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|BEARER[_-]?TOKEN|PASSWORD|SECRET)|GH_TOKEN|GITHUB_TOKEN)\s*[:=]\s*(?:["'][^"'\r\n]*["']|[^\s,;]+)/giu,
  /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/giu,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[oprsu]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/gu,
];
const privatePathPatterns: readonly RegExp[] = [
  /["']\/(?:Users|home|root|tmp|var\/tmp)\/[^"'\r\n]+["']/gu,
  /\/Users\/[^/\s]+(?:\/[^\s"'`,;:)\]}]*)?/gu,
  /\/home\/[^/\s]+(?:\/[^\s"'`,;:)\]}]*)?/gu,
  /\/(?:root|tmp|var\/tmp)\/[^\s"'`,;:)\]}]+/gu,
  /\/(?:private\/var\/folders|private\/tmp|var\/folders)\/[^\s"'`,;:)\]}]+/gu,
  /["'][A-Za-z]:\\Users\\[^"'\r\n]+["']/gu,
  /[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s"'`,;:)\]}]*)?/gu,
];

export function redactAdvisorText(value: string, maxChars = 250_000): string {
  let redacted = value.replace(/\r\n?/gu, "\n");
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, REDACTED_SECRET);
  }
  for (const pattern of privatePathPatterns) {
    redacted = redacted.replace(pattern, REDACTED_PATH);
  }
  redacted = redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (redacted.length <= maxChars) return redacted;
  const truncated = redacted.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
}

export function redactAdvisorResponse(response: AdvisorReviewResponse): AdvisorReviewResponse {
  const review = response.review === undefined
    ? undefined
    : redactAdvisorText(response.review);
  const error = response.error === undefined
    ? undefined
    : {
        ...response.error,
        message: redactAdvisorText(response.error.message, 512).trim() || "The advisor review failed.",
      };
  return {
    ...response,
    ...(review === undefined ? {} : { review }),
    ...(error === undefined ? {} : { error }),
  };
}
