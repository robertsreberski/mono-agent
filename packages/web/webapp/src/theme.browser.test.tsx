import { commands, page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import "./styles.css";
import { applyConsolePresentation, THEME_CHROME_COLORS } from "./theme";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
  }
}

const THEMES = ["evergreen", "ocean", "plum", "terracotta"] as const;
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, minHeight: "64px", paddingBlock: "10px" },
  { name: "mobile", width: 390, height: 844, minHeight: "58px", paddingBlock: "7px" },
] as const;

interface Rgba {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

interface HeaderPresentation {
  readonly header: Rgba;
  readonly panel: Rgba;
  readonly effectiveRgb: readonly [number, number, number];
  readonly geometry: {
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly minHeight: string;
    readonly paddingTop: string;
    readonly paddingRight: string;
    readonly paddingBottom: string;
    readonly paddingLeft: string;
  };
}

function seedInitialThemeMetas(): readonly [HTMLMetaElement, HTMLMetaElement] {
  const initialDocument = new DOMParser().parseFromString(indexHtml, "text/html");
  const metas = Array.from(initialDocument.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  if (metas.length !== 2) throw new Error(`Expected two initial theme-color metas, received ${metas.length}`);
  const clones = metas.map((meta) => document.head.appendChild(meta.cloneNode(true))) as HTMLMetaElement[];
  return [clones[0]!, clones[1]!];
}

function renderHeaderFixture(): { readonly panel: HTMLElement; readonly header: HTMLElement } {
  const panel = document.createElement("main");
  panel.className = "chat-panel";
  const header = document.createElement("header");
  header.className = "chat-header";
  panel.append(header);
  document.body.append(panel);
  return { panel, header };
}

function parseComputedColor(color: string): Rgba {
  const srgb = color.match(
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s+\/\s+([\d.]+))?\)$/,
  );
  if (srgb) {
    return {
      red: Number(srgb[1]) * 255,
      green: Number(srgb[2]) * 255,
      blue: Number(srgb[3]) * 255,
      alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)\s*,?\s+([\d.]+)\s*,?\s+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
  );
  if (rgb) {
    return {
      red: Number(rgb[1]),
      green: Number(rgb[2]),
      blue: Number(rgb[3]),
      alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  throw new Error(`Unsupported computed color: ${color}`);
}

function readHeaderPresentation(panel: HTMLElement, header: HTMLElement): HeaderPresentation {
  const panelStyle = getComputedStyle(panel);
  const headerStyle = getComputedStyle(header);
  const panelColor = parseComputedColor(panelStyle.backgroundColor);
  const headerColor = parseComputedColor(headerStyle.backgroundColor);
  const composite = (foreground: number, background: number) =>
    Math.round(foreground * headerColor.alpha + background * (1 - headerColor.alpha));
  const rect = header.getBoundingClientRect();
  return {
    header: headerColor,
    panel: panelColor,
    effectiveRgb: [
      composite(headerColor.red, panelColor.red),
      composite(headerColor.green, panelColor.green),
      composite(headerColor.blue, panelColor.blue),
    ],
    geometry: {
      top: rect.top,
      width: rect.width,
      height: rect.height,
      minHeight: headerStyle.minHeight,
      paddingTop: headerStyle.paddingTop,
      paddingRight: headerStyle.paddingRight,
      paddingBottom: headerStyle.paddingBottom,
      paddingLeft: headerStyle.paddingLeft,
    },
  };
}

function expectApplicableMeta(content: string): void {
  const matching = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    .filter((meta) => matchMedia(meta.media).matches);
  expect(matching).toHaveLength(1);
  expect(matching[0]!.content).toBe(content);
}

async function emulateColorScheme(colorScheme: "light" | "dark"): Promise<void> {
  await commands.emulateColorScheme(colorScheme);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(matchMedia(`(prefers-color-scheme: ${colorScheme})`).matches).toBe(true);
}

function expectHeaderColors(presentation: HeaderPresentation, expectedRgb: readonly [number, number, number]): void {
  expect(presentation.header.alpha).toBeCloseTo(0.94, 2);
  expect(presentation.panel.alpha).toBe(1);
  expect(presentation.effectiveRgb).toEqual(expectedRgb);
}

afterEach(async () => {
  await commands.emulateColorScheme(null);
  await page.viewport(414, 896);
  delete document.documentElement.dataset.consoleTheme;
  document.title = "";
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.body.replaceChildren();
});

describe.each(VIEWPORTS)("header chrome at $name viewport", (viewport) => {
  it("transitions the initial shell between real light and dark media", async () => {
    await page.viewport(viewport.width, viewport.height);
    seedInitialThemeMetas();
    const { panel, header } = renderHeaderFixture();

    await emulateColorScheme("light");
    const light = readHeaderPresentation(panel, header);
    expectHeaderColors(light, [253, 253, 251]);
    expectApplicableMeta(THEME_CHROME_COLORS.evergreen.light);

    await emulateColorScheme("dark");
    const dark = readHeaderPresentation(panel, header);
    expectHeaderColors(dark, [25, 28, 26]);
    expectApplicableMeta(THEME_CHROME_COLORS.evergreen.dark);
    expect(dark.geometry).toEqual(light.geometry);
  });

  it.each(THEMES)("keeps %s chrome aligned through bootstrap and a live scheme change", async (theme) => {
    await page.viewport(viewport.width, viewport.height);
    const [initialLightMeta, initialDarkMeta] = seedInitialThemeMetas();
    const initialLight = initialLightMeta.content;
    const initialDark = initialDarkMeta.content;
    const { panel, header } = renderHeaderFixture();
    document.title = "before";

    await emulateColorScheme("light");
    const restore = applyConsolePresentation({ hostName: "builder-01", displayName: "Builder", theme });
    const light = readHeaderPresentation(panel, header);
    expectHeaderColors(light, [253, 253, 251]);
    expectApplicableMeta(THEME_CHROME_COLORS[theme].light);
    expect(light.geometry.minHeight).toBe(viewport.minHeight);
    expect(light.geometry.paddingTop).toBe(viewport.paddingBlock);
    expect(light.geometry.paddingBottom).toBe(viewport.paddingBlock);

    await emulateColorScheme("dark");
    const dark = readHeaderPresentation(panel, header);
    expectHeaderColors(dark, [25, 28, 26]);
    expectApplicableMeta(THEME_CHROME_COLORS[theme].dark);
    expect(dark.geometry).toEqual(light.geometry);

    restore();
    expect(document.documentElement).not.toHaveAttribute("data-console-theme");
    expect(document.title).toBe("before");
    expect(initialLightMeta.content).toBe(initialLight);
    expect(initialDarkMeta.content).toBe(initialDark);
  });
});
