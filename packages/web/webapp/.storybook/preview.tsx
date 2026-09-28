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
  if (pathname === "/api/v1/agents/atlas/cron/jobs/garden-daily/run" && init?.method === "POST") {
    return Promise.resolve(Response.json({ kind: "confirmation_required", confirmation: { token: "fictional-confirmation", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), message: "Run the fictional garden schedule now?" } }, { status: 428 }));
  }
  if (pathname === "/api/v1/agents/atlas/cron/config-view" && (!init?.method || init.method === "GET")) {
    return Promise.resolve(Response.json({ configView: { label: "Example garden schedule", fields: [{ id: "schedule", label: "Schedule", value: "0 9 * * *", source: "example", redacted: false }, { id: "target", label: "Destination", value: "[redacted]", source: "example", redacted: true }] } }));
  }
  const compact = /^\/api\/v1\/threads\/garden-compact-(result|error|skipped|model|failed|pending|lost)\/compact$/.exec(pathname);
  if (compact && init?.method === "POST") {
    const kind = compact[1];
    if (kind === "pending") return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    if (kind === "lost") return Promise.reject(new TypeError("Example connection lost."));
    if (kind === "error") return Promise.resolve(Response.json({ error: { message: "Example compaction was unavailable.", code: "unavailable" } }, { status: 503 }));
    return Promise.resolve(Response.json(kind === "result"
      ? { status: "succeeded", trigger: "manual", operationId: "fictional-operation", tokensBefore: 183400, tokensAfter: 41300, tokenCountsExact: false }
      : { status: kind === "model" || kind === "skipped" ? "skipped" : "failed", trigger: "manual", operationId: "fictional-operation", ...(kind === "model" ? { reason: "model_changed" } : {}) }));
  }
  const usage = /^\/api\/v1\/threads\/garden-usage-(typical|mixed|pending)\/usage$/.exec(pathname);
  if (usage && (!init?.method || init.method === "GET")) {
    if (usage[1] === "pending") return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    const mixed = usage[1] === "mixed";
    return Promise.resolve(Response.json({ usage: {
      total: { tokens: mixed ? { input: 22000, cacheRead: 76000, cacheWrite: 2000, output: 22000 }
        : { input: 16000, cacheRead: 82000, cacheWrite: 2000, output: 11000 },
        costUsd: mixed ? 4.18 : 2.24, ...(mixed ? { tokensPartial: true } : {}) },
      ...(mixed ? { subagents: { runs: 3, costUsd: 1.12, tokensPartial: true } } : {}),
      byModel: mixed ? [{ model: "atlas/standard", costUsd: 3.06 }, { model: "grove/fast", costUsd: 1.12 }]
        : [{ model: "atlas/standard", costUsd: 2.24 }],
      computedAt: "2026-09-19T12:00:00Z", settledAssistantTurns: mixed ? 5 : 1,
    } }));
  }
  if (/^\/api\/v1\/agents\/atlas-story-usage(?:-loading|-stale|-error)?\/provider-usage$/.test(pathname) && (!init?.method || init.method === "GET")) {
    if (pathname.includes("-loading/")) {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    const hour = 60 * 60 * 1000;
    const fetchedAt = new Date(Date.now() - hour).toISOString();
    const window = (kind: "session" | "weekly" | "model", label: "Session" | "Weekly" | "Fable", usedPercent: number, periodMs: number, remainingMs: number) =>
      ({ kind, label, usedPercent, periodMs, resetsAt: new Date(Date.parse(fetchedAt) + remainingMs).toISOString() });
    const stale = pathname.includes("-stale/");
    const error = pathname.includes("-error/");
    return Promise.resolve(Response.json({ schema: "mono-agent.provider-usage.v1", providers: [{ providerId: "anthropic", label: "Claude", fetchedAt, stale,
      windows: error ? [] : [window("session", "Session", 12, 5 * hour, 4 * hour), window("weekly", "Weekly", 52, 7 * 24 * hour, 5 * 24 * hour), window("model", "Fable", 92, 30 * 24 * hour, 20 * 24 * hour)],
      ...(stale || error ? { error: { code: "auth_failed", message: "Credential rejected; re-login to this provider." } } : {}),
    }] }));
  }
  const auth = /^\/api\/v1\/agents\/(atlas-story-auth-(missing|verified))\/provider-auth$/.exec(pathname);
  if (auth && (!init?.method || init.method === "GET")) {
    const verified = auth[2] === "verified";
    return Promise.resolve(new Response(JSON.stringify({
      schema: "mono-agent.provider-auth.v1", generatedAt: "2026-01-15T10:00:00Z",
      providers: [{ providerId: "atlas", label: "Atlas Cloud", usages: [{ kind: "primary", model: "atlas/standard", label: "Interactive" }],
        state: verified ? "present" : "missing", verification: verified ? "verified_by_account_request" : "not_verified",
        credentialType: verified ? "oauth" : undefined, source: verified ? "stored" : undefined,
        methods: [{ authType: "oauth", strategy: "device_code", label: "Sign in with Atlas", recommended: true }],
      }],
    }), { headers: { "Content-Type": "application/json" } }));
  }
  if (/^\/api\/v1\/agents\/atlas-story-auth-(missing|verified)\/restart$/.test(pathname) && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify({ operation: null }), { headers: { "Content-Type": "application/json" } }));
  }
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
    return <AssistantRuntimeProvider runtime={runtime}><NotificationsProvider>{context.parameters.layout === "fullscreen"
      ? <Story />
      : <div style={{ background: "var(--app-bg)", color: "var(--text)", minHeight: "85vh", padding: 24 }}><Story /></div>
    }</NotificationsProvider></AssistantRuntimeProvider>;
  }],
};

export default preview;
