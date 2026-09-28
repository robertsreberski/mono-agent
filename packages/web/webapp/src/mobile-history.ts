export type SettingsSection = "new-conversations" | "providers" | "agent";

export type MobileScreen = "dashboard" | "conversation";
export type MobileHistorySurface =
  | { readonly version: 1; readonly surface: MobileScreen }
  | { readonly version: 1; readonly surface: "project"; readonly projectId: string }
  | { readonly version: 1; readonly surface: "settings"; readonly section: SettingsSection | null; readonly depth: 1 | 2 };
export type MobileHistoryEntry = MobileHistorySurface & { readonly href?: string };
const MOBILE_HISTORY_STATE_KEY = "monoAgentMobileNavigation";

const mobileHistoryHref = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === window.location.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
};

export const mobileHistoryEntry = (state: unknown): MobileHistoryEntry | null => {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const candidate = (state as Record<string, unknown>)[MOBILE_HISTORY_STATE_KEY];
  if (typeof candidate !== "object" || candidate === null) return null;
  const entry = candidate as Record<string, unknown>;
  if (entry.version !== 1) return null;
  const href = mobileHistoryHref(entry.href);
  if (entry.surface === "dashboard" || entry.surface === "conversation") {
    return { version: 1, surface: entry.surface, ...(href === undefined ? {} : { href }) };
  }
  if (entry.surface === "project" && typeof entry.projectId === "string" && entry.projectId.length > 0) {
    return { version: 1, surface: "project", projectId: entry.projectId, ...(href === undefined ? {} : { href }) };
  }
  if (entry.surface === "settings" && (entry.section === null || entry.section === "new-conversations" || entry.section === "providers" || entry.section === "agent")
    && (entry.depth === 1 || entry.depth === 2) && href === window.location.href
    && ((entry.depth === 1 && entry.section === null) || (entry.depth === 2 && entry.section !== null))) {
    return { version: 1, surface: "settings", section: entry.section, depth: entry.depth, href };
  }
  return null;
};

export const ownedSettingsEntry = (state: unknown = window.history.state): Extract<MobileHistoryEntry, { surface: "settings" }> | null => {
  const entry = mobileHistoryEntry(state);
  return entry?.surface === "settings" ? entry : null;
};

/** Keep all unrelated history.state fields when a route writer changes URL. */
export const routeWriteState = (state: unknown, nextUrl: string | URL, mode: "push" | "replace"): unknown => {
  const current = mobileHistoryEntry(state);
  if (current?.surface !== "settings") return state;
  const href = new URL(nextUrl, window.location.href).href;
  const fields = typeof state === "object" && state !== null && !Array.isArray(state)
    ? state as Record<string, unknown> : {};
  return { ...fields, [MOBILE_HISTORY_STATE_KEY]: mode === "push"
    ? { version: 1, surface: "conversation", href }
    : { ...current, href } };
};

const stateWithMobileHistoryEntry = (entry: MobileHistorySurface, href: string): Record<string, unknown> => ({
  ...(typeof window.history.state === "object"
    && window.history.state !== null
    && !Array.isArray(window.history.state)
    ? window.history.state as Record<string, unknown>
    : {}),
  [MOBILE_HISTORY_STATE_KEY]: { ...entry, href },
});

export const replaceMobileHistoryEntry = (entry: MobileHistorySurface, target = window.location.href): void => {
  const href = new URL(target, window.location.href).href;
  window.history.replaceState(stateWithMobileHistoryEntry(entry, href), "", href);
};

export const pushMobileHistoryEntry = (entry: MobileHistorySurface, target = window.location.href): void => {
  const href = new URL(target, window.location.href).href;
  window.history.pushState(stateWithMobileHistoryEntry(entry, href), "", href);
};

