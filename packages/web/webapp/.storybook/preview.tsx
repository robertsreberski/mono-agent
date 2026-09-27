import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { NotificationsProvider } from "../src/notifications";
import css from "../src/styles.css?raw";
import "../src/styles.css";

// Storybook-only forced appearances: replay the real token declarations with a
// more specific selector. The shipped app keeps its OS-driven media query.
const source = new CSSStyleSheet();
source.replaceSync(css);
const themeRule = (rule: CSSRule): rule is CSSStyleRule =>
  rule instanceof CSSStyleRule && /^:root(?:\[data-console-theme="[^"]+"\])?$/.test(rule.selectorText);
const collect = (rules: CSSRuleList, mode: string) =>
  Array.from(rules).filter(themeRule).map((rule) =>
    `${rule.selectorText.replace(":root", `:root[data-storybook-scheme="${mode}"]`)} { ${rule.style.cssText} }`,
  ).join("\n");
const dark = Array.from(source.cssRules).find((rule) =>
  rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-color-scheme: dark"),
);
const style = document.createElement("style");
style.textContent = `${collect(source.cssRules, "light")}\n${dark instanceof CSSMediaRule ? collect(dark.cssRules, "dark") : ""}\n:root[data-storybook-scheme="light"] { color-scheme: light; }\n:root[data-storybook-scheme="dark"] { color-scheme: dark; }`;
document.head.append(style);

// Refuse all console API requests in previews. Storybook's own static assets
// still load normally; a new component effect cannot contact a live console.
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(url, location.href).pathname;
  // This read-only fixture lets schedule editor examples show their actual
  // create/edit/paused controls; no mutation ever contacts a console.
  const match = /^\/api\/v1\/threads\/(garden-planner|garden-active|garden-paused)\/wake-schedule$/.exec(pathname);
  if (match && (!init?.method || init.method === "GET")) {
    const id = match[1]!;
    const schedule = id === "garden-planner" ? null : {
      scheduleId: `example-${id}`, threadId: id, sourceId: "atlas",
      definition: id === "garden-paused"
        ? { kind: "weekly", timezone: "UTC", days: [1, 3], times: ["09:00"], message: "Check the fictional garden" }
        : { kind: "once", timezone: "UTC", localAt: "2026-10-15T09:00", message: "Review the garden plan" },
      state: id === "garden-paused" ? "paused" : "active", revision: 1,
      nextFireAt: id === "garden-paused" ? null : "2026-10-15T09:00:00Z",
      lastOutcome: null, createdAt: "2026-01-15T10:00:00Z",
    };
    return Promise.resolve(new Response(JSON.stringify({ schedule }), { headers: { "Content-Type": "application/json" } }));
  }
  if (pathname.startsWith("/api/")) {
    return Promise.reject(new Error("Console API is disabled in Storybook"));
  }
  return originalFetch(input, init);
};

const preview: Preview = {
  globalTypes: {
    theme: { description: "Console palette", toolbar: { icon: "paintbrush", items: ["evergreen", "ocean", "plum", "terracotta"] } },
    scheme: { description: "Appearance", toolbar: { icon: "circlehollow", items: ["light", "dark"] } },
  },
  initialGlobals: { theme: "evergreen", scheme: "light", viewport: { value: "desktop" } },
  parameters: {
    layout: "padded",
    viewport: { options: {
      phone: { name: "Phone (360px)", styles: { width: "360px", height: "780px" } },
      mobile: { name: "Mobile (560px)", styles: { width: "560px", height: "800px" } },
      tablet: { name: "Tablet (900px)", styles: { width: "900px", height: "800px" } },
      desktop: { name: "Desktop (1200px)", styles: { width: "1200px", height: "850px" } },
    } },
  },
  decorators: [(Story, context) => {
    // Set before children paint, then undo on unmount. Never modify product CSS.
    const theme = String(context.globals.theme ?? "evergreen");
    const scheme = String(context.globals.scheme ?? "light");
    document.documentElement.dataset.consoleTheme = theme;
    document.documentElement.dataset.storybookScheme = scheme;
    useEffect(() => () => {
      delete document.documentElement.dataset.consoleTheme;
      delete document.documentElement.dataset.storybookScheme;
    }, []);
    const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "Example only" }] }) });
    return <AssistantRuntimeProvider runtime={runtime}><NotificationsProvider><div style={{ background: "var(--app-bg)", color: "var(--text)", minHeight: "85vh", padding: 24 }}><Story /></div></NotificationsProvider></AssistantRuntimeProvider>;
  }],
};

export default preview;
