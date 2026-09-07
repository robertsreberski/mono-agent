import { afterEach, describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import manifestText from "../public/manifest.webmanifest?raw";
import { applyConsolePresentation, THEME_CHROME_COLORS } from "./theme";

const THEMES = ["evergreen", "ocean", "plum", "terracotta"] as const;

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
  it.each(THEMES)("sets and restores the %s theme, title, and header chrome colors", (theme) => {
    const light = addThemeColorMeta("(prefers-color-scheme: light)", "#ffffff");
    const dark = addThemeColorMeta("(prefers-color-scheme: dark)", "#000000");
    document.title = "before";

    const restore = applyConsolePresentation({ hostName: "builder-01", displayName: "builder-01", theme });

    expect(document.documentElement.dataset.consoleTheme).toBe(theme);
    expect(document.title).toBe("builder-01 · mono-agent");
    expect(light.getAttribute("media")).toBe("(prefers-color-scheme: light)");
    expect(dark.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    expect(light.content).toBe(THEME_CHROME_COLORS[theme].light);
    expect(dark.content).toBe(THEME_CHROME_COLORS[theme].dark);

    restore();
    expect(document.documentElement).not.toHaveAttribute("data-console-theme");
    expect(document.title).toBe("before");
    expect(light.content).toBe("#ffffff");
    expect(dark.content).toBe("#000000");
  });

  it("restores an existing theme and absent meta contents", () => {
    const light = addThemeColorMeta("(prefers-color-scheme: light)", "");
    const dark = addThemeColorMeta("(prefers-color-scheme: dark)", "");
    light.removeAttribute("content");
    dark.removeAttribute("content");
    document.documentElement.dataset.consoleTheme = "ocean";

    const restore = applyConsolePresentation({ hostName: "builder-01", displayName: "builder-01", theme: "plum" });
    restore();

    expect(document.documentElement.dataset.consoleTheme).toBe("ocean");
    expect(light).not.toHaveAttribute("content");
    expect(dark).not.toHaveAttribute("content");
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

describe("initial PWA chrome", () => {
  it("starts with evergreen header colors and the default iOS status mode", () => {
    const initialDocument = new DOMParser().parseFromString(indexHtml, "text/html");
    const light = initialDocument.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
    );
    const dark = initialDocument.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
    );
    const statusMode = initialDocument.head.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-status-bar-style"]',
    );

    expect(light?.content).toBe(THEME_CHROME_COLORS.evergreen.light);
    expect(dark?.content).toBe(THEME_CHROME_COLORS.evergreen.dark);
    expect(statusMode?.content).toBe("default");
  });

  it("keeps manifest chrome and launch background distinct", () => {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    expect(manifest.theme_color).toBe(THEME_CHROME_COLORS.evergreen.dark);
    expect(manifest.background_color).toBe("#0f1110");
  });
});
