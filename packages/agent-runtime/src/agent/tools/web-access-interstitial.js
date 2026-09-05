// @ts-check

const MAX_INTERSTITIAL_SAMPLE_CHARS = 32 * 1024;

/**
 * Classify access and authentication interstitials without treating incidental
 * words such as "captcha" or "access denied" as conclusive evidence.
 *
 * @param {{url?: string, text?: string, statusCode?: number}} input
 * @returns {{code: "access_challenge"|"authentication_required", message: string}|undefined}
 */
export function classifyWebAccessInterstitial({ url, text, statusCode } = {}) {
  const finalUrl = String(url || "");
  const sample = normalizedSample(text);

  const challengeArtifact = /\b(?:cf-chl-[\w-]+|cloudflare ray id|challenge-platform)\b/iu.test(sample);
  const humanCheck = /\bverify (?:you are|that you are)(?: a)? human\b/iu.test(sample);
  const browserCheck = /\bchecking your browser before accessing\b|\bunusual traffic from (?:your computer|this computer) network\b/iu.test(sample);
  const securityVerification = /\bperforming security verification\b/iu.test(sample);
  const javascriptCookieGate = /\benable javascript and cookies to continue\b/iu.test(sample);
  const waitHeading = /\bjust a moment(?:\.{1,3})?\b/iu.test(sample);
  const blockedAccess = /\baccess denied\b[\s\S]{0,240}\b(?:blocked|permission|reference|administrator)\b/iu.test(sample);

  if (/\/(?:captcha|challenge)(?:[/?#]|$)/iu.test(finalUrl)
    || challengeArtifact
    || humanCheck
    || browserCheck
    || blockedAccess
    || (securityVerification && javascriptCookieGate)
    || (waitHeading && (securityVerification || javascriptCookieGate))) {
    return {
      code: "access_challenge",
      message: "Page presented an access challenge; no bypass was attempted.",
    };
  }

  if (statusCode === 401 || statusCode === 407
    || /\/(?:login|signin|sign-in)(?:[/?#]|$)/iu.test(finalUrl)
    || /\bauthentication required\b/iu.test(sample)
    || /\b(?:sign|log) in to continue\b/iu.test(sample)
    || (/\bsession (?:has )?expired\b/iu.test(sample) && /\b(?:sign|log) in\b/iu.test(sample))) {
    return {
      code: "authentication_required",
      message: "Page requires authentication; no login was attempted.",
    };
  }
  return undefined;
}

/**
 * @param {{url?: string, text?: string, statusCode?: number}} input
 */
export function assertNoWebAccessInterstitial(input) {
  const classified = classifyWebAccessInterstitial(input);
  if (classified) throw Object.assign(new Error(classified.message), { code: classified.code });
}

function normalizedSample(value) {
  return String(value || "")
    .slice(0, MAX_INTERSTITIAL_SAMPLE_CHARS)
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
