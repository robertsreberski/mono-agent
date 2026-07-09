import { describe, expect, it } from "vitest";

import {
  formatMarkdownForSlack,
  normalizeSlackMarkdownToMarkdown,
} from "../slack-markdown.js";

describe("formatMarkdownForSlack", () => {
  it("translates common Markdown inline styles to Slack mrkdwn", () => {
    expect(formatMarkdownForSlack("**bold** __also bold__ *italic* ~~gone~~")).toBe(
      "*bold* *also bold* _italic_ ~gone~",
    );
  });

  it("translates Markdown links and escapes Slack control characters", () => {
    expect(
      formatMarkdownForSlack("Read [the report](https://example.com?a=1&b=2) <soon> & carefully"),
    ).toBe(
      "Read <https://example.com?a=1&amp;b=2|the report> &lt;soon&gt; &amp; carefully",
    );
  });

  it("formats headings while preserving list and quote shape", () => {
    expect(
      formatMarkdownForSlack("## Summary\n- first item\n> quoted **text**"),
    ).toBe(
      "*Summary*\n- first item\n> quoted *text*",
    );
  });

  it("preserves inline and fenced code blocks", () => {
    const markdown = "Use `**literal** <value>`\n```ts\nconst value = \"<raw>\";\n```";

    expect(formatMarkdownForSlack(markdown)).toBe(markdown);
  });

  it("keeps inline code separate from generated Slack links", () => {
    expect(formatMarkdownForSlack("Use `[raw](value)` and [real](https://example.com)")).toBe(
      "Use `[raw](value)` and <https://example.com|real>",
    );
  });
});

describe("normalizeSlackMarkdownToMarkdown", () => {
  it("normalizes Slack standup-style bullets, links, nbsp indentation, and emphasis", () => {
    const slack = [
      "\u2022 Jetpack 16.0 release lead / release wrangling",
      "\u00a0\u00a0\u25e6 Cut and coordinated <https://github.com/Automattic/jetpack-production/releases/tag/16.0-beta|Jetpack 16.0-beta>, including <https://linear.app/a8c/issue/ATOMIC-1081/jetpack-160-beta|ATOMIC-1081>.",
      "",
      "\u2022 _Jetpack.com / Jetpack 2026 launch work_",
      "\u00a0\u00a0\u25e6 Landed <https://github.a8c.com/Automattic/wpcom-a8c-themes/pull/157805|theme update>.",
    ].join("\n");

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      [
        "- Jetpack 16.0 release lead / release wrangling",
        "  - Cut and coordinated [Jetpack 16.0-beta](https://github.com/Automattic/jetpack-production/releases/tag/16.0-beta), including [ATOMIC-1081](https://linear.app/a8c/issue/ATOMIC-1081/jetpack-160-beta).",
        "",
        "- *Jetpack.com / Jetpack 2026 launch work*",
        "  - Landed [theme update](https://github.a8c.com/Automattic/wpcom-a8c-themes/pull/157805).",
      ].join("\n"),
    );
  });

  it("translates Slack inline styles and escapes back to standard Markdown text", () => {
    expect(
      normalizeSlackMarkdownToMarkdown("*bold* _italic_ ~gone~ <https://example.com?a=1&amp;b=2|the report> &lt;soon&gt; &amp; carefully"),
    ).toBe(
      "**bold** *italic* ~~gone~~ [the report](https://example.com?a=1&b=2) <soon> & carefully",
    );
  });

  it("preserves inline and fenced code while normalizing surrounding Slack text", () => {
    const slack = "Use `<https://example.com|literal>`\n```txt\n*literal* <raw>\n```\n*outside*";

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      "Use `<https://example.com|literal>`\n```txt\n*literal* <raw>\n```\n**outside**",
    );
  });
});
