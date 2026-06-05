import { describe, expect, it } from "vitest";

import { formatMarkdownForSlack } from "../slack-markdown.js";

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
