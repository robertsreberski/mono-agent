import { forceStandaloneStyles } from "./test/standalone-styles";
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
  const initialDocument = new DOMParser().parseFromString(indexHtml, "text/html");
  const sampler = initialDocument.querySelector(".status-bar-surface")!;
  const root = document.createElement("div");
  root.id = "root";
  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.append(panel);
  root.append(shell);
  document.body.append(sampler.cloneNode(true), root);
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
  const sampler = document.querySelector<HTMLElement>(".status-bar-surface")!;
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  const samplerStyle = getComputedStyle(sampler);
  const samplerRect = sampler.getBoundingClientRect();
  expect(samplerStyle.position).toBe("fixed");
  expect(samplerStyle.top).toBe("0px");
  expect(samplerRect.top).toBe(0);
  expect(samplerRect.left).toBe(0);
  expect(samplerRect.width).toBe(window.innerWidth);
  expect(samplerRect.height).toBe(0); // Chromium browser tab has no top safe-area inset.
  expect(samplerStyle.pointerEvents).toBe("none");
  expect(samplerStyle.zIndex).toBe("50");
  expect(sampler.inert).toBe(true);
  expect(sampler.tabIndex).toBe(-1);
  expect(samplerStyle.backgroundColor).toBe(getComputedStyle(shell).backgroundColor);
  expect(samplerStyle.backgroundColor).toBe(getComputedStyle(document.body).backgroundColor);
  expect(samplerStyle.backgroundColor).toBe(getComputedStyle(document.documentElement).backgroundColor);
  expect(document.elementsFromPoint(10, 0)).not.toContain(sampler);
  expect(shell.getBoundingClientRect().top).toBe(0);
  expect(shell.getBoundingClientRect().height).toBe(window.innerHeight);
  const shellRect = shell.getBoundingClientRect().toJSON();
  const headerRect = header.getBoundingClientRect().toJSON();
  sampler.remove();
  expect(shell.getBoundingClientRect().toJSON()).toEqual(shellRect);
  expect(header.getBoundingClientRect().toJSON()).toEqual(headerRect);
  document.body.prepend(sampler);

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

/**
 * The declared chrome colour, as numbers: what the strip above the header is
 * asked to paint. The header has to resolve to exactly this, or the system
 * strip and the console meet in a seam.
 */
function declaredChrome(hex: string): readonly [number, number, number] {
  const channels = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu);
  if (channels === null) throw new Error(`Unsupported chrome colour: ${hex}`);
  return [
    Number.parseInt(channels[1]!, 16),
    Number.parseInt(channels[2]!, 16),
    Number.parseInt(channels[3]!, 16),
  ];
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
  document.documentElement.style.removeProperty("--status-bar-inset");
  restoreStandaloneStyles?.();
  restoreStandaloneStyles = undefined;
  document.title = "";
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  document.body.replaceChildren();
});

describe.each(VIEWPORTS)("header chrome at $name viewport", (viewport) => {
  it.each(THEMES)("exposes a fixed top edge with %s's header colour in both appearances", async (theme) => {
    await page.viewport(viewport.width, viewport.height);
    const { header } = renderHeaderFixture();
    applyConsolePresentation({ hostName: "builder-01", displayName: "Builder", theme });
    const strip = document.querySelector<HTMLElement>(".status-bar-surface")!;
    const shell = document.querySelector<HTMLElement>(".app-shell")!;
    const before = [shell, header].map((element) => element.getBoundingClientRect().toJSON());
    expect(strip.getBoundingClientRect().height).toBe(0);
    document.documentElement.style.setProperty("--status-bar-inset", "47px");
    for (const scheme of ["light", "dark"] as const) {
      await emulateColorScheme(scheme);
      const style = getComputedStyle(strip);
      const rect = strip.getBoundingClientRect();
      expect(style.position).toBe("fixed");
      expect(style.zIndex).toBe("50");
      expect(style.opacity).toBe("1");
      expect(style.backdropFilter).toBe("none");
      expect(style.backgroundColor).toBe(getComputedStyle(shell).backgroundColor);
      expect(parseComputedColor(style.backgroundColor).alpha).toBe(1);
      expect(rect.width).toBeGreaterThanOrEqual(window.innerWidth * 0.9);
      expect(rect.height).toBe(47); // >10px: WebKit uses the box's CSS background directly.
      expect(rect.top).toBe(0);
      expect(getComputedStyle(header).paddingTop).toBe("47px");
      expect(style.pointerEvents).toBe("none");
      // Chromium's elementFromPoint honours pointer-events; WebKit's first
      // fixedContainerEdges hit test ignores them. Temporarily enable hits.
      strip.inert = false; // Chromium also suppresses hits on inert nodes.
      strip.style.pointerEvents = "auto";
      expect(document.elementFromPoint(window.innerWidth / 2, 4)).toBe(strip);
      strip.style.removeProperty("pointer-events");
      strip.inert = true;
    }
    document.documentElement.style.removeProperty("--status-bar-inset");
    expect(strip.getBoundingClientRect().height).toBe(0);
    expect([shell, header].map((element) => element.getBoundingClientRect().toJSON())).toEqual(before);
  });
  it("transitions the initial shell between real light and dark media", async () => {
    await page.viewport(viewport.width, viewport.height);
    seedInitialThemeMetas();
    const { panel, header } = renderHeaderFixture();

    await emulateColorScheme("light");
    const light = readHeaderPresentation(panel, header);
    expectHeaderColors(light, declaredChrome(THEME_CHROME_COLORS.evergreen.light));
    expectApplicableMeta(THEME_CHROME_COLORS.evergreen.light);

    await emulateColorScheme("dark");
    const dark = readHeaderPresentation(panel, header);
    expectHeaderColors(dark, declaredChrome(THEME_CHROME_COLORS.evergreen.dark));
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
    expectHeaderColors(light, declaredChrome(THEME_CHROME_COLORS[theme].light));
    expectApplicableMeta(THEME_CHROME_COLORS[theme].light);
    expect(light.geometry.minHeight).toBe(viewport.minHeight);
    expect(light.geometry.paddingTop).toBe(viewport.paddingBlock);
    expect(light.geometry.paddingBottom).toBe(viewport.paddingBlock);

    await emulateColorScheme("dark");
    const dark = readHeaderPresentation(panel, header);
    expectHeaderColors(dark, declaredChrome(THEME_CHROME_COLORS[theme].dark));
    expectApplicableMeta(THEME_CHROME_COLORS[theme].dark);
    expect(dark.geometry).toEqual(light.geometry);

    restore();
    expect(document.documentElement).not.toHaveAttribute("data-console-theme");
    expect(document.title).toBe("before");
    expect(initialLightMeta.content).toBe(initialLight);
    expect(initialDarkMeta.content).toBe(initialDark);
  });
});

// Exercise the production standalone rule via CSSOM; Chromium still supplies
// browser-tab system chrome, not an installed iOS status bar.
let restoreStandaloneStyles: (() => void) | undefined;
describe.each([
  { name: "standalone mini portrait", width: 744, height: 1133, inset: 0, installed: true },
  { name: "standalone mini landscape", width: 1133, height: 744, inset: 0, installed: true },
  { name: "standalone window", width: 600, height: 900, inset: 0, installed: true },
  { name: "older install with inset", width: 744, height: 1133, inset: 32, installed: true },
  { name: "standalone iPhone portrait", width: 390, height: 844, inset: 0, installed: true },
  { name: "iPhone portrait tab", width: 390, height: 844, inset: 47, installed: false },
  { name: "standalone iPhone landscape", width: 844, height: 390, inset: 0, installed: true },
  { name: "desktop browser tab", width: 1440, height: 900, inset: 0, installed: false },
  { name: "browser tab with inset", width: 1440, height: 900, inset: 32, installed: false },
] as const)("native top edge on $name", (scenario) => {
  it("uses only the safe inset, keeping all headers, dialogs and toast clear", async () => {
    await page.viewport(scenario.width, scenario.height);
    const html = document.documentElement;
    html.style.setProperty("--status-bar-inset", `${scenario.inset}px`);
    if (scenario.installed) restoreStandaloneStyles = forceStandaloneStyles();
    const initialDocument = new DOMParser().parseFromString(indexHtml, "text/html");
    const strip = initialDocument.querySelector<HTMLElement>(".status-bar-surface")!;
    const root = document.createElement("div");
    root.id = "root";
    root.innerHTML = `<div class="app-shell">
      <div class="dashboard-panel"><div class="dashboard"><header class="dashboard-header">
        <div class="dashboard-title-block"><span class="eyebrow">Console</span><strong>Agent</strong></div>
        <button>New conversation</button></header></div></div>
      <div class="chat-region"><div class="chat-panel"><header class="chat-header">
        <div class="chat-title-block"><span class="eyebrow">Conversation</span><button>Title</button></div>
        <button>Options</button></header></div></div></div>
      <div class="project-page" style="position:absolute;top:0;width:340px;height:100%"><header class="project-header"><button class="project-back">Back</button>
        <button>Project actions</button></header></div>
      <div class="settings-screen" style="position:absolute;top:0;width:340px;height:100%"><header class="settings-header"><span class="eyebrow">Settings</span><button>Close settings</button></header></div>
      <div class="console-error"><button>Retry</button></div>`;
    document.body.append(strip, root);
    for (const scheme of ["light", "dark"] as const) {
      await emulateColorScheme(scheme);
      const sampler = strip.getBoundingClientRect();
      expect(sampler.top).toBe(0);
      expect(sampler.width).toBe(scenario.width);
      expect(sampler.height).toBe(scenario.installed ? Math.max(6, scenario.inset) : scenario.inset);
      const style = getComputedStyle(strip);
      expect(style.position).toBe("fixed");
      expect(style.zIndex).toBe("50");
      expect(style.opacity).toBe("1");
      expect(style.pointerEvents).toBe("none");
      expect(style.backgroundColor).toBe(getComputedStyle(document.querySelector(".app-shell")!).backgroundColor);
      expect(parseComputedColor(style.backgroundColor).alpha).toBe(1);
      expect(document.elementFromPoint(innerWidth / 2, 4)).not.toBe(strip);
      if (sampler.height >= 6) {
        strip.inert = false;
        strip.style.pointerEvents = "auto";
        expect(document.elementFromPoint(innerWidth / 2, 4)).toBe(strip);
        strip.style.removeProperty("pointer-events");
        strip.inert = true;
      }
      for (const selector of [".dashboard-header", ".chat-header", ".project-header", ".settings-header"]) {
        const header = document.querySelector<HTMLElement>(selector)!;
        expect(getComputedStyle(header).paddingTop).toBe(`${Math.max(scenario.width <= 900 ? 7 : 10, scenario.inset)}px`);
        expect(header.getBoundingClientRect().top).toBe(0);
        for (const content of header.querySelectorAll<HTMLElement>("button, .eyebrow")) {
          expect(content.getBoundingClientRect().top).toBeGreaterThanOrEqual(sampler.bottom);
        }
      }
      expect(document.querySelector(".console-error")!.getBoundingClientRect().top).toBe(Math.max(12, scenario.inset));
    }
    const dialog = document.createElement("div");
    dialog.className = "sheet-layer";
    dialog.innerHTML = '<section class="sheet" role="dialog"><header class="sheet-head"><button class="sheet-cancel">Cancel</button><h2>Fictional project</h2><button class="sheet-save">Save</button></header></section>';
    document.body.append(dialog);
    expect(Number(getComputedStyle(dialog).zIndex)).toBeGreaterThan(Number(getComputedStyle(strip).zIndex));
    for (const button of dialog.querySelectorAll("button")) {
      const rect = button.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(strip.getBoundingClientRect().bottom);
      expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(button);
    }
  });
});
