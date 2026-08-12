import type { ConsoleIdentity, WebTheme } from "./types";

export const THEME_CHROME_COLORS: Readonly<
  Record<WebTheme, { readonly light: string; readonly dark: string }>
> = {
  evergreen: { light: "#eeefeb", dark: "#0f1110" },
  ocean: { light: "#edf1f4", dark: "#0d1115" },
  plum: { light: "#f2eef3", dark: "#120f14" },
  terracotta: { light: "#f4efec", dark: "#130f0d" },
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
  document.title = `${identity.hostName} · mono-agent`;
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
