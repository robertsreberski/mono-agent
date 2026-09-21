// Pure blog helpers shared by Astro pages and node unit tests.
//
// This module must stay dependency-free (no astro imports) so
// `node --test tests/blog.test.mjs` can import it directly.
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 80;
export const TITLE_MIN = 20;
export const TITLE_MAX = 70;
export const DESCRIPTION_MIN = 110;
export const DESCRIPTION_MAX = 160;
export const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_TAGS = 5;
export const POSTS_PER_PAGE = 12;
export const WORDS_PER_MINUTE = 200;

/** True when `slug` is a valid blog entry id (folder name and URL slug). */
export function isValidSlug(slug) {
  return (
    typeof slug === "string" &&
    slug.length > 0 &&
    slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug)
  );
}

/** Throw a build-failing error when `slug` is not a valid blog slug. */
export function assertValidSlug(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid blog slug ${JSON.stringify(slug)}: must match ${SLUG_PATTERN} and be at most ${MAX_SLUG_LENGTH} characters.`,
    );
  }
  return slug;
}

export function isValidTitle(title) {
  return (
    typeof title === "string" &&
    title.length >= TITLE_MIN &&
    title.length <= TITLE_MAX
  );
}

export function isValidDescription(description) {
  return (
    typeof description === "string" &&
    description.length >= DESCRIPTION_MIN &&
    description.length <= DESCRIPTION_MAX
  );
}

export function isValidTag(tag) {
  return typeof tag === "string" && tag.length > 0 && TAG_PATTERN.test(tag);
}

/** Approximate word count of a Markdown `body` (fenced code excluded). */
export function countWords(body) {
  return String(body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^A-Za-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Whole-minute reading time for Markdown `body` (at least 1 minute). */
export function readingTimeMinutes(body) {
  return Math.max(1, Math.ceil(countWords(body) / WORDS_PER_MINUTE));
}

/** Human reading-time label, e.g. "1 min read" / "4 min read". */
export function readingTimeLabel(body) {
  const minutes = readingTimeMinutes(body);
  return `${minutes} min read`;
}

/** ISO date (`YYYY-MM-DD`) for sitemap `<lastmod>` and feed output. */
export function toISODate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** Compare two blog entries newest-first by publishDate. */
export function compareNewestFirst(a, b) {
  return new Date(b.data.publishDate) - new Date(a.data.publishDate);
}
