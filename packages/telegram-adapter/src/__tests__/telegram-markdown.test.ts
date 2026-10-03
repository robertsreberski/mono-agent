import { describe, expect, it } from "vitest";

import { renderTelegramMarkdown } from "../telegram-markdown.js";

describe("renderTelegramMarkdown", () => {
  it("renders bold using MarkdownV2 single-asterisk syntax", () => {
    expect(renderTelegramMarkdown("**bold**")).toBe("*bold*");
  });

  it("preserves inline code spans", () => {
    expect(renderTelegramMarkdown("Run `npm i` now")).toBe("Run `npm i` now");
  });

  it("keeps parenthesized URLs intact by escaping the inner parens", () => {
    const out = renderTelegramMarkdown(
      "See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)).",
    );
    // The whole URL survives (old regex converter truncated it at the first ")").
    expect(out).toContain("https://en.wikipedia.org/wiki/Foo_\\(bar\\)");
    expect(out).not.toContain("Foo_(bar)");
  });

  it("resolves overlapping emphasis into valid, non-overlapping markup", () => {
    const out = renderTelegramMarkdown("**bold _and** italic_");
    // Old converter emitted overlapping <b>/<i> → invalid → raw-markdown fallback.
    expect(out).not.toContain("**");
    expect(out).toBe("*bold \\_and* italic\\_");
  });

  it("renders bold spanning multiple lines", () => {
    expect(renderTelegramMarkdown("**line one\nline two**")).toBe(
      "*line one\nline two*",
    );
  });

  it("escapes MarkdownV2 reserved characters in prose", () => {
    expect(renderTelegramMarkdown("Cost is 5_000 (approx) > 4.")).toBe(
      "Cost is 5\\_000 \\(approx\\) \\> 4\\.",
    );
  });

  it("renders GFM tables as native MarkdownV2 code blocks", () => {
    const out = renderTelegramMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");

    expect(out).toBe([
      "```",
      "A   │ B",
      "────┼────",
      "1   │ 2",
      "```",
    ].join("\n"));
    expect(out).not.toContain("\\|");
  });

  it("keeps surrounding emphasis while flattening table-cell formatting", () => {
    const out = renderTelegramMarkdown([
      "**Nem, a vasárnap esti hazaérkezés is jó.**",
      "",
      "| Változat | Indulás (munka után) | Hazaérkezés | Éjszakák | Szabadnap |",
      "|---|---|---|---|---|",
      "| **A** | **kedd, márc. 9.** | **vasárnap, ápr. 4.** | **26** | 15 |",
      "| B | péntek, márc. 12. | szerda, ápr. 7. | 26 | 15 |",
      "",
      "Az **A** változatot javaslom.",
    ].join("\n"));

    expect(out.startsWith("*Nem, a vasárnap esti hazaérkezés is jó\\.*\n\n```")).toBe(true);
    expect(out).toContain("A        │ kedd, márc. 9. ");
    expect(out).toContain("B        │ péntek, márc. 12.");
    expect(out.endsWith("```\n\nAz *A* változatot javaslom\\.")).toBe(true);
    expect(out).not.toContain("**");
    expect(out).not.toContain("\\|");
  });

  it("preserves literal separators and aligns common Unicode display widths", () => {
    const out = renderTelegramMarkdown([
      "| Key | Value |",
      "|---|---|",
      "| A │ B | x |",
      "| 古 | y |",
      "| é | z |",
    ].join("\n"));

    expect(out).toContain("A │ B │ x");
    expect(out).not.toContain("A \\│ B");
    expect(out).toContain("古    │ y");
    expect(out).toContain("é     │ z");
  });

  it("preserves link destinations when flattening table cells", () => {
    const out = renderTelegramMarkdown([
      "| Name | Site |",
      "|---|---|",
      "| **Docs** | [Open](https://example.com/a_(b)) |",
    ].join("\n"));

    expect(out).toContain("Docs");
    expect(out).toContain("Open (https://example.com/a_(b))");
  });

  it("does not treat pipe-like prose or fenced code as a table", () => {
    expect(renderTelegramMarkdown("A | B")).toBe("A \\| B");
    expect(renderTelegramMarkdown("```\n| A | B |\n|---|---|\n```"))
      .toBe("```\n| A | B |\n|---|---|\n```");
  });

  it("trims the trailing newline the converter appends", () => {
    expect(renderTelegramMarkdown("hello")).toBe("hello");
  });

  it("returns an empty string for empty input", () => {
    expect(renderTelegramMarkdown("")).toBe("");
  });
});
