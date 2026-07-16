import { describe, expect, test } from "vitest";

import { Markdown, esc, md, mdInline } from "./markdown";
import { FONT_MONO } from "./tokens";

const ALLOWED_TAGS = new Set(["a", "code", "div", "em", "li", "ol", "strong", "ul"]);
const RENDERER_OPENING_TAGS = new Set([
  `<code style="font-family:${FONT_MONO};background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.88em;color:#D9C9A8;overflow-wrap:anywhere;word-break:break-word">`,
  '<div style="height:7px">',
  '<div style="font-weight:600;font-size:13px;color:#F2F0EA;margin:9px 0 3px">',
  '<div style="font-weight:600;font-size:15px;color:#F2F0EA;margin:9px 0 3px">',
  '<div style="font-weight:600;font-size:17px;color:#F2F0EA;margin:9px 0 3px">',
  '<em style="color:#DAD7D0">',
  '<li style="margin:3px 0">',
  '<ol style="margin:4px 0;padding-left:19px">',
  '<strong style="font-weight:600;color:#F2F0EA">',
  '<ul style="margin:4px 0;padding-left:19px">',
]);

function expectOnlyRendererTags(html: string): void {
  const tagPattern = /<[^>]*>/gu;
  const openTags: string[] = [];
  let cursor = 0;

  for (const match of html.matchAll(tagPattern)) {
    const index = match.index;
    expect(html.slice(cursor, index)).not.toMatch(/[<>]/u);

    const tag = match[0];
    const parsed = tag.match(/^<\/?([a-z]+)(?:\s[^<>]*)?>$/u);
    expect(parsed, `unexpected literal tag: ${tag}`).not.toBeNull();
    expect(ALLOWED_TAGS.has(parsed?.[1] ?? ""), `non-renderer tag: ${tag}`).toBe(true);
    expect(tag).not.toMatch(/\son[a-z]+\s*=/iu);

    if (tag.startsWith("</")) {
      expect(tag).toMatch(/^<\/(?:a|code|div|em|li|ol|strong|ul)>$/u);
      expect(openTags.at(-1), `unmatched or misnested closing tag: ${tag}`).toBe(parsed?.[1]);
      openTags.pop();
    } else if (tag.startsWith("<a ")) {
      expect(tag).toMatch(
        /^<a href="https?:\/\/[^"<>\s]+" target="_blank" rel="noopener" style="color:#7FB0E4;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">$/u,
      );
    } else if (tag === "<div>") {
      expect(tag).toBe("<div>");
    } else {
      expect(RENDERER_OPENING_TAGS.has(tag), `unexpected renderer opening tag: ${tag}`).toBe(true);
    }
    if (!tag.startsWith("</")) openTags.push(parsed?.[1] ?? "");

    cursor = index + tag.length;
  }

  expect(html.slice(cursor)).not.toMatch(/[<>]/u);
  expect(openTags, "renderer tags must be balanced").toEqual([]);
}

describe("esc", () => {
  test("escapes script tags, ampersands, and both quote forms before formatting", () => {
    expect(esc(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
    );
    expect(esc(null)).toBe("null");
  });

  test("does not double-decode entity-shaped input", () => {
    expect(esc("&lt;img src=x onerror=alert(1)&gt; &#60;script&#62;")).toBe(
      "&amp;lt;img src=x onerror=alert(1)&amp;gt; &amp;#60;script&amp;#62;",
    );
  });
});

describe("mdInline", () => {
  test("wraps supported inline markdown only after escaping its content", () => {
    const html = mdInline(
      "`<script>code()</script>` [quoted](https://example.test/a\"onmouseover=\"boom) **<b>bold</b>** *<i>em</i>*",
    );

    expect(html).toContain("<code ");
    expect(html).toContain("&lt;script&gt;code()&lt;/script&gt;");
    expect(html).toContain('href="https://example.test/a&quot;onmouseover=&quot;boom"');
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).toContain("<strong ");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("<em ");
    expect(html).toContain("&lt;i&gt;em&lt;/i&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expectOnlyRendererTags(html);
  });

  test("leaves unsafe and incomplete links inert instead of creating anchors", () => {
    const html = mdInline([
      "[script](javascript:alert(1))",
      "[data](data:text/html,<svg/onload=alert(1)>)",
      "[relative](/admin)",
      "[unfinished](https://example.test",
    ].join(" "));

    expect(html).not.toContain("<a ");
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain("&lt;svg/onload=alert(1)&gt;");
    expectOnlyRendererTags(html);
  });

  test("keeps unmatched markdown markers literal", () => {
    const input = "`unterminated **bold *italic [link](https://example.test";
    const html = mdInline(input);

    expect(html).toBe(input);
    expect(html).not.toMatch(/<(?:a|code|em|strong)\b/u);
    expectOnlyRendererTags(html);
  });

  test("keeps encoded entities single-escaped and inert", () => {
    const html = mdInline("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

    expect(html).toBe("&amp;lt;script&amp;gt;alert(&amp;quot;x&amp;quot;)&amp;lt;/script&amp;gt;");
    expect(html).not.toContain("<script");
    expectOnlyRendererTags(html);
  });

  test("keeps raw renderer-tag lookalikes escaped instead of trusting their tag names", () => {
    const input = [
      "<a>anchor</a>",
      "<code>code</code>",
      "<div>div</div>",
      '<em style="color:#DAD7D0">emphasis</em>',
      "<li>item</li>",
      "<ol>ordered</ol>",
      "<strong>strong</strong>",
      "<ul>unordered</ul>",
    ].join(" ");
    const html = mdInline(input);

    expect(html).toBe(
      "&lt;a&gt;anchor&lt;/a&gt; &lt;code&gt;code&lt;/code&gt; &lt;div&gt;div&lt;/div&gt; " +
      "&lt;em style=&quot;color:#DAD7D0&quot;&gt;emphasis&lt;/em&gt; &lt;li&gt;item&lt;/li&gt; " +
      "&lt;ol&gt;ordered&lt;/ol&gt; &lt;strong&gt;strong&lt;/strong&gt; &lt;ul&gt;unordered&lt;/ul&gt;",
    );
    expect(html).not.toMatch(/<(?:a|code|div|em|li|ol|strong|ul)(?:\s|>)/u);
    expectOnlyRendererTags(html);
  });

  test("does not format markdown markers inside a serialized link href", () => {
    const html = mdInline(
      "[bold path](https://example.test/**segment**) [em path](https://example.test/*part*)",
    );

    expect(html).toContain('href="https://example.test/**segment**"');
    expect(html).toContain('href="https://example.test/*part*"');
    expect(html).not.toContain("<strong ");
    expect(html).not.toContain("<em ");
    expectOnlyRendererTags(html);
  });

  test("keeps inline fragments opaque and structurally balanced across token boundaries", () => {
    const html = mdInline(
      "`[literal](https://example.test) **not bold**` " +
      "**[outer](https://example.test/outer)** [**inner**](https://example.test/inner)",
    );

    expect(html).toContain("[literal](https://example.test) **not bold**</code>");
    expect(html.match(/<a /gu)).toHaveLength(2);
    expect(html.match(/<strong /gu)).toHaveLength(2);
    expectOnlyRendererTags(html);

    const unmatchedAcrossLink = mdInline("[**x](https://example.test)**");
    expect(unmatchedAcrossLink).toContain(">**x</a>**");
    expectOnlyRendererTags(unmatchedAcrossLink);
  });

  test("restores protected fragments literally even when input resembles replacement syntax", () => {
    const userToken = "\0 mono-agent-inline:0 \0";
    const html = mdInline(`${userToken} \`$& $'\` [cash](https://example.test/$&)`);

    expect(html).toMatch(/^\0 mono-agent-inline:0 \0 /u);
    expect(html).toContain(">$&amp; $&#39;</code>");
    expect(html).toContain('href="https://example.test/$&amp;"');
    expectOnlyRendererTags(html);
  });
});

describe("md", () => {
  test("renders every supported block shape while keeping a mixed payload inert", () => {
    const html = md([
      "# <script>alert(1)</script>",
      "## [quoted](https://example.test/a\"onclick=\"boom)",
      "### **third <img src=x onerror=alert(1)>**",
      "#### fourth",
      "- unordered `<svg onload=alert(1)>`",
      "* second &lt;iframe&gt;",
      "1. ordered [unsafe](javascript:alert(1))",
      "2. ordered *safe emphasis*",
      "",
      "plain [unfinished](https://example.test and **unfinished",
    ].join("\n"));

    expect(html).toContain('font-size:17px');
    expect(html).toContain('font-size:15px');
    expect(html.match(/font-size:13px/gu)).toHaveLength(2);
    expect(html).toContain("<ul ");
    expect(html).toContain("</ul>");
    expect(html).toContain("<ol ");
    expect(html).toContain("</ol>");
    expect(html).toContain('<div style="height:7px"></div>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
    expect(html).toContain("&amp;lt;iframe&amp;gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<iframe");
    expectOnlyRendererTags(html);
  });

  test("returns an empty string for empty input and closes a trailing list", () => {
    expect(md("")).toBe("");

    const html = md("- one\n- two");
    expect(html).toMatch(/^<ul [^>]*><li [^>]*>one<\/li><li [^>]*>two<\/li><\/ul>$/u);
    expectOnlyRendererTags(html);
  });
});

describe("Markdown", () => {
  test("passes only md output to the sole dangerouslySetInnerHTML consumer", () => {
    const src = "<script>alert(1)</script> **safe**";
    const element = Markdown({ src, style: { color: "red" } });
    const props = element.props as {
      readonly style: Record<string, unknown>;
      readonly dangerouslySetInnerHTML: { readonly __html: string };
    };

    expect(element.type).toBe("div");
    expect(props.style).toMatchObject({
      overflowWrap: "anywhere",
      wordBreak: "break-word",
      color: "red",
    });
    expect(props.dangerouslySetInnerHTML).toEqual({ __html: md(src) });
    expect(props.dangerouslySetInnerHTML.__html).not.toContain("<script");
    expectOnlyRendererTags(props.dangerouslySetInnerHTML.__html);

    const defaultElement = Markdown({ src: "plain" });
    expect(defaultElement.props).toMatchObject({
      style: { overflowWrap: "anywhere", wordBreak: "break-word" },
    });
  });
});
