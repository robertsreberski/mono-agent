// @ts-check

const MAX_INTERSTITIAL_SAMPLE_CHARS = 32 * 1024;
const MAX_BROAD_HUMAN_CHECK_CHARS = 500;

/**
 * Classify access and authentication interstitials without treating incidental
 * words such as "captcha" or "access denied" as conclusive evidence.
 *
 * @param {{url?: string, text?: string, statusCode?: number, headers?: Headers}} input
 * @returns {{code: "access_challenge"|"authentication_required", message: string}|undefined}
 */
export function classifyWebAccessInterstitial({ url, text, statusCode, headers } = {}) {
  const finalUrl = String(url || "");
  const pathname = urlPathname(finalUrl);
  const sample = normalizedSample(text);

  const challengeArtifact = /\b(?:cf-chl-[\w-]+|cloudflare ray id|challenge-platform)\b/iu.test(sample);
  // Keep the original conclusive signals independent of document length.
  const humanCheck = /\bverify (?:you are|that you are)(?: a)? human\b/iu.test(sample);
  // Only the broader new wording is limited to short visible content. Inline
  // scripts/styles must not inflate that length or contribute vocabulary.
  const visibleSample = normalizedSample(String(text || "")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " "));
  const shortContent = visibleSample.length <= MAX_BROAD_HUMAN_CHECK_CHARS;
  const tinyBody = String(text || "").length <= 256;
  const broadHumanCheck = /\bhuman or a bot\b|\bprove (?:you are|you're) human\b|\bare you a robot\b|\bshow us your human side\b/iu.test(visibleSample);
  const verificationVocabulary = /\b(?:verify|verification|prove|check|checking|security)\b/iu;
  const vocabularyScore = [/\b(?:captcha|challenge)\b/iu, /\b(?:bot|robot)\b/iu,
    /\bhuman\b/iu, verificationVocabulary]
    .filter((pattern) => pattern.test(visibleSample)).length;
  const challengeHeader = headers && [...headers.entries()].some(([name, value]) =>
    /(?:cf-mitigated|page-id|challenge|captcha)/iu.test(name) && /challenge|captcha/iu.test(value));
  // Vocabulary alone is not a refusal: ordinary 2xx glossaries can contain
  // every category. A tiny challenge-status response supplies corroboration.
  const structuralChallenge = challengeHeader
    || (tinyBody && [403, 429, 202, 503].includes(statusCode ?? 0)
      && verificationVocabulary.test(visibleSample) && vocabularyScore >= 2);
  const browserCheck = /\bchecking your browser before accessing\b|\bunusual traffic from (?:your computer|this computer) network\b/iu.test(sample);
  const securityVerification = /\bperforming security verification\b/iu.test(sample);
  const javascriptCookieGate = /\benable javascript and cookies to continue\b/iu.test(sample);
  const waitHeading = /\bjust a moment(?:\.{1,3})?\b/iu.test(sample);
  const blockedAccess = /\baccess denied\b[\s\S]{0,240}\b(?:blocked|permission|reference|administrator)\b/iu.test(sample);

  if (/\/(?:captcha|challenge)(?:\/|$)/iu.test(pathname)
    || challengeArtifact
    || structuralChallenge
    || humanCheck
    || browserCheck
    || blockedAccess
    || (securityVerification && javascriptCookieGate)
    || (waitHeading && (securityVerification || javascriptCookieGate))
    || (shortContent && broadHumanCheck)) {
    return {
      code: "access_challenge",
      message: "Page presented an access challenge; no bypass was attempted.",
    };
  }

  if (statusCode === 401 || statusCode === 407
    || /\/(?:login|signin|sign-in)(?:\/|$)/iu.test(pathname)
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

function urlPathname(value) {
  try { return new URL(value).pathname; }
  catch { return ""; }
}

/**
 * @param {{url?: string, text?: string, statusCode?: number, headers?: Headers}} input
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
