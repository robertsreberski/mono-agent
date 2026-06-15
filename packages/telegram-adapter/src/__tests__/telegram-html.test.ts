import { describe, expect, it } from "vitest";

import { escapeTelegramHtml, renderTelegramHtml } from "../telegram-html.js";

describe("escapeTelegramHtml", () => {
  it("escapes the three reserved characters only", () => {
    expect(escapeTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(escapeTelegramHtml("no specials")).toBe("no specials");
  });
});

describe("renderTelegramHtml", () => {
  it("returns plain text unchanged when there is no markup", () => {
    expect(renderTelegramHtml("just a plain sentence")).toBe("just a plain sentence");
  });

  it("does not treat ordinary numbers as code placeholders", () => {
    expect(renderTelegramHtml("I have 3 apples and 5 oranges")).toBe(
      "I have 3 apples and 5 oranges",
    );
  });

  it("renders bold, italic, and strikethrough", () => {
    expect(renderTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(renderTelegramHtml("__bold__")).toBe("<b>bold</b>");
    expect(renderTelegramHtml("*italic*")).toBe("<i>italic</i>");
    expect(renderTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  it("renders inline code and escapes its contents", () => {
    expect(renderTelegramHtml("use `a < b` here")).toBe(
      "use <code>a &lt; b</code> here",
    );
  });

  it("renders fenced code blocks with an optional language", () => {
    expect(renderTelegramHtml("```\nx = 1 < 2\n```")).toBe("<pre>x = 1 &lt; 2</pre>");
    expect(renderTelegramHtml("```python\nprint(1)\n```")).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
  });

  it("renders links", () => {
    expect(renderTelegramHtml("see [docs](https://example.com/x)")).toBe(
      'see <a href="https://example.com/x">docs</a>',
    );
  });

  it("renders headings as bold and bullets for lists", () => {
    expect(renderTelegramHtml("# Title\n- one\n- two")).toBe(
      "<b>Title</b>\n• one\n• two",
    );
  });

  it("escapes reserved characters in surrounding prose", () => {
    expect(renderTelegramHtml("compare a<b and c>d & done")).toBe(
      "compare a&lt;b and c&gt;d &amp; done",
    );
  });
});
