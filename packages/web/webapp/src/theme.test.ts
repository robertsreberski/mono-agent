import { afterEach, describe, expect, it } from "vitest";
import { applyConsolePresentation, THEME_CHROME_COLORS } from "./theme";

const addThemeColorMeta = (media: string, content: string) => {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.setAttribute("media", media);
  meta.content = content;
  document.head.append(meta);
  return meta;
};

afterEach(() => {
  delete document.documentElement.dataset.consoleTheme;
  document.title = "";
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
});

describe("applyConsolePresentation", () => {
  it("sets and restores the theme, title, and light/dark browser colors", () => {
    const light = addThemeColorMeta("(prefers-color-scheme: light)", "#ffffff");
    const dark = addThemeColorMeta("(prefers-color-scheme: dark)", "#000000");
    document.title = "before";

    const restore = applyConsolePresentation({ hostName: "builder-01", displayName: "builder-01", theme: "terracotta" });

    expect(document.documentElement.dataset.consoleTheme).toBe("terracotta");
    expect(document.title).toBe("builder-01 · mono-agent");
    expect(light.content).toBe(THEME_CHROME_COLORS.terracotta.light);
    expect(dark.content).toBe(THEME_CHROME_COLORS.terracotta.dark);

    restore();
    expect(document.documentElement).not.toHaveAttribute("data-console-theme");
    expect(document.title).toBe("before");
    expect(light.content).toBe("#ffffff");
    expect(dark.content).toBe("#000000");
  });

  it("titles the tab with the operator-chosen name rather than the hostname", () => {
    const restore = applyConsolePresentation({
      hostName: "flockbox",
      displayName: "Flockbox",
      theme: "evergreen",
    });

    expect(document.title).toBe("Flockbox · mono-agent");
    restore();
  });
});
