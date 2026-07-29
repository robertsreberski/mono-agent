import { describe, expect, it } from "vitest";

import {
  formatMarkdownForSlack,
  normalizeSlackMarkdownToMarkdown,
  renderSlackMentionTokens,
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

  it("preserves balanced parentheses in Markdown link destinations", () => {
    expect(
      formatMarkdownForSlack("Read [Wikipedia](https://en.wikipedia.org/wiki/Parenthesis_(rhetoric))"),
    ).toBe("Read <https://en.wikipedia.org/wiki/Parenthesis_(rhetoric)|Wikipedia>");
    expect(
      formatMarkdownForSlack("Read [nested](https://example.com/a_(b_(c)))"),
    ).toBe("Read <https://example.com/a_(b_(c))|nested>");
    expect(
      formatMarkdownForSlack("Read [escaped](https://example.com/a\\))"),
    ).toBe("Read <https://example.com/a)|escaped>");
    expect(
      formatMarkdownForSlack("Read [escaped](https://example.com/a\\(b)"),
    ).toBe("Read <https://example.com/a(b|escaped>");
    expect(
      formatMarkdownForSlack(String.raw`Read [escaped](https://example.com/a\\\(b)`),
    ).toBe(String.raw`Read <https://example.com/a\(b|escaped>`);
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

  it("restores nested protected segments without leaking sentinel tokens", () => {
    // A link inside bold nests one protected token inside another token's
    // payload; ascending-order restore left the inner token unrestored and
    // leaked U+E000/U+E001 sentinels into delivered Slack messages.
    expect(formatMarkdownForSlack("**see [x](https://u.example)**")).toBe(
      "*see <https://u.example|x>*",
    );
    expect(
      formatMarkdownForSlack("**[a](https://a.example)** and __[b](https://b.example)__"),
    ).toBe("*<https://a.example|a>* and *<https://b.example|b>*");
    expect(formatMarkdownForSlack("**see [x](https://u.example)**")).not.toMatch(/[]/u);
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

  it("emits valid Markdown destinations for Slack links with parentheses", () => {
    expect(
      normalizeSlackMarkdownToMarkdown(
        "<https://en.wikipedia.org/wiki/Parenthesis_(rhetoric)|Wikipedia>",
      ),
    ).toBe("[Wikipedia](https://en.wikipedia.org/wiki/Parenthesis_%28rhetoric%29)");
  });

  it("normalizes nonbreaking spaces outside, but not inside, protected code", () => {
    const nonbreakingSpace = "\u00a0";
    const slack = `outside${nonbreakingSpace}text \`inline${nonbreakingSpace}code\`\n\`\`\`txt\nfenced${nonbreakingSpace}code\n\`\`\``;

    expect(normalizeSlackMarkdownToMarkdown(slack)).toBe(
      `outside text \`inline${nonbreakingSpace}code\`\n\`\`\`txt\nfenced${nonbreakingSpace}code\n\`\`\``,
    );
  });
});

describe("renderSlackMentionTokens", () => {
  it("uses the label Slack already inlines, with no API call", () => {
    expect(renderSlackMentionTokens("hey <@U08ABC|alice> and <@U0DEF|bob>")).toBe("hey @alice and @bob");
  });

  it("renders channel, broadcast, and user-group tokens", () => {
    expect(renderSlackMentionTokens("<#C1|general>")).toBe("#general");
    expect(renderSlackMentionTokens("<!here> <!channel> <!everyone>")).toBe("@here @channel @everyone");
    expect(renderSlackMentionTokens("<!subteam^S1|@design>")).toBe("@design");
    expect(renderSlackMentionTokens("<!date^1700000000^{date_short}|Nov 14>")).toBe("@Nov 14");
  });

  // Still better than the opaque token; the opt-in directory upgrades it later.
  it("degrades a label-less token to its id rather than dropping it", () => {
    expect(renderSlackMentionTokens("ping <@U08ABC>")).toBe("ping @U08ABC");
    expect(renderSlackMentionTokens("see <#C0DEF>")).toBe("see #C0DEF");
  });

  it("leaves links and code spans untouched", () => {
    expect(renderSlackMentionTokens("<https://example.com|site> and <mailto:a@b.c>"))
      .toBe("<https://example.com|site> and <mailto:a@b.c>");
    expect(renderSlackMentionTokens("`<@U08ABC>` literal")).toBe("`<@U08ABC>` literal");
    expect(renderSlackMentionTokens("```\n<@U08ABC>\n```")).toBe("```\n<@U08ABC>\n```");
  });
});
