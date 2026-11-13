import { ownedSettingsEntry, pushMobileHistoryEntry, type SettingsSection } from "./mobile-history";

export const parseSettingsParam = (href: string): SettingsSection | null | undefined => {
  const value = new URL(href).searchParams.get("settings");
  if (value === "index") return null;
  if (value === "restart") return "agent"; // Legacy section link.
  return value === "capabilities" || value === "agent" || value === "providers" || value === "new-conversations" ? value : undefined;
};

export const stripSettingsParam = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete("settings");
  return url.href;
};

export const pushSettingsEntries = (section: SettingsSection | null): void => {
  if (ownedSettingsEntry() !== null) return;
  pushMobileHistoryEntry({ version: 1, surface: "settings", section, depth: 1 });
};

export const closeSettingsHistory = (): void => {
  const entry = ownedSettingsEntry();
  if (entry !== null) window.history.go(-entry.depth);
};

/** A source-qualified init handoff must never fall back to a different agent. */
export function consoleHandoffTarget(href: string): string | null {
  const url = new URL(href);
  const target = url.searchParams.get("agent");
  return target !== null && target.length > 0 && target.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(target) ? target : null;
}
