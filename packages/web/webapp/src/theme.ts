import type { ConsoleIdentity, WebTheme } from "./types";

export const THEME_CHROME_COLORS: Readonly<
  Record<WebTheme, { readonly light: string; readonly dark: string }>
> = {
  evergreen: { light: "#fdfdfb", dark: "#191c1a" },
  ocean: { light: "#fdfdfb", dark: "#191c1a" },
  plum: { light: "#fdfdfb", dark: "#191c1a" },
  terracotta: { light: "#fdfdfb", dark: "#191c1a" },
};

const THEME_COLOR_MEDIA = [
  "(prefers-color-scheme: light)",
  "(prefers-color-scheme: dark)",
] as const;

/** Apply server-selected host identity to browser chrome and the CSS theme root. */
export function applyConsolePresentation(identity: ConsoleIdentity): () => void {
  const root = document.documentElement;
  const previousTheme = root.dataset.consoleTheme;
  const previousTitle = document.title;
  const themeColors = THEME_CHROME_COLORS[identity.theme];
  const metas = THEME_COLOR_MEDIA.map((media) =>
    document.head.querySelector<HTMLMetaElement>(`meta[name="theme-color"][media="${media}"]`));
  const previousMetaColors = metas.map((meta) => meta?.getAttribute("content"));

  root.dataset.consoleTheme = identity.theme;
  document.title = `${identity.displayName} · mono-agent`;
  metas[0]?.setAttribute("content", themeColors.light);
  metas[1]?.setAttribute("content", themeColors.dark);

  return () => {
    if (previousTheme === undefined) delete root.dataset.consoleTheme;
    else root.dataset.consoleTheme = previousTheme;
    document.title = previousTitle;
    metas.forEach((meta, index) => {
      const previous = previousMetaColors[index];
      if (previous === null || previous === undefined) meta?.removeAttribute("content");
      else meta?.setAttribute("content", previous);
    });
  };
}
