// Unit contracts for the pure blog helpers in src/blog.mjs.
//
// Run from marketing/:
//   node --test tests/blog.test.mjs
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  compareNewestFirst,
  countWords,
  isValidDescription,
  isValidSlug,
  isValidTag,
  isValidTitle,
  assertValidSlug,
  readingTimeLabel,
  readingTimeMinutes,
  toISODate,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  MAX_SLUG_LENGTH,
  POSTS_PER_PAGE,
  TITLE_MAX,
  TITLE_MIN,
} from "../src/blog.mjs";

describe("blog slugs", () => {
  it("accepts lowercase kebab-case folder names", () => {
    for (const slug of ["hello", "local-first-agent-workflows", "a1-b2-c3", "x".repeat(MAX_SLUG_LENGTH)]) {
      assert.ok(isValidSlug(slug), `${slug} is valid`);
      assert.equal(assertValidSlug(slug), slug);
    }
  });

  it("rejects anything that is not a URL-safe folder slug", () => {
    for (const slug of ["", "Hello", "has space", "has_underscore", "trailing-", "-leading", "double--dash", "UPPER", "café", "a/b", "2026", "2", "12-3", "x".repeat(MAX_SLUG_LENGTH + 1), undefined, 42]) {
      assert.equal(isValidSlug(slug), false, `${String(slug)} is invalid`);
      assert.throws(() => assertValidSlug(slug), /Invalid blog slug/);
    }
  });
});

describe("front-matter length rules", () => {
  it("keeps titles between 20 and 70 characters", () => {
    assert.equal(TITLE_MIN, 20);
    assert.equal(TITLE_MAX, 70);
    assert.equal(isValidTitle("x".repeat(19)), false);
    assert.equal(isValidTitle("x".repeat(20)), true);
    assert.equal(isValidTitle("x".repeat(70)), true);
    assert.equal(isValidTitle("x".repeat(71)), false);
  });

  it("keeps descriptions between 110 and 160 characters", () => {
    assert.equal(DESCRIPTION_MIN, 110);
    assert.equal(DESCRIPTION_MAX, 160);
    assert.equal(isValidDescription("x".repeat(109)), false);
    assert.equal(isValidDescription("x".repeat(110)), true);
    assert.equal(isValidDescription("x".repeat(160)), true);
    assert.equal(isValidDescription("x".repeat(161)), false);
  });

  it("accepts one to five lowercase kebab-case tags", () => {
    for (const tag of ["workflows", "local-first", "a1"]) assert.ok(isValidTag(tag));
    for (const tag of ["", "Has-Caps", "has space", "under_score"]) assert.equal(isValidTag(tag), false);
    assert.equal(POSTS_PER_PAGE, 12);
  });
});

describe("reading time", () => {
  it("floors empty posts at one minute", () => {
    assert.equal(readingTimeMinutes(""), 1);
    assert.equal(readingTimeMinutes("   "), 1);
    assert.equal(readingTimeLabel(""), "1 min read");
  });

  it("reads 200 words per minute rounding up", () => {
    const words = (n) => Array(n).fill("word").join(" ");
    assert.equal(readingTimeMinutes(words(200)), 1);
    assert.equal(readingTimeMinutes(words(201)), 2);
    assert.equal(readingTimeLabel(words(450)), "3 min read");
  });

  it("excludes fenced code from the count", () => {
    const body = `${"word ".repeat(200)}\n\`\`\`json\n${"code ".repeat(500)}\n\`\`\``;
    assert.equal(countWords(body), 200);
    assert.equal(readingTimeMinutes(body), 1);
  });
});

describe("dates and ordering", () => {
  it("formats sitemap dates as ISO calendar days", () => {
    assert.equal(toISODate("2026-09-18"), "2026-09-18");
    assert.equal(toISODate(new Date("2026-09-19T12:00:00Z")), "2026-09-19");
  });

  it("sorts newest first by publishDate", () => {
    const entry = (date) => ({ data: { publishDate: date } });
    const posts = [entry("2026-09-10"), entry("2026-09-18"), entry("2026-09-01")];
    assert.deepEqual(
      [...posts].sort(compareNewestFirst).map((post) => post.data.publishDate),
      ["2026-09-18", "2026-09-10", "2026-09-01"],
    );
  });
});
