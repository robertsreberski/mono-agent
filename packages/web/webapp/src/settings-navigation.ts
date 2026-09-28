import { ownedSettingsEntry, pushMobileHistoryEntry, type SettingsSection } from "./mobile-history";

export const parseSettingsParam = (href: string): SettingsSection | null | undefined => {
  const value = new URL(href).searchParams.get("settings");
  if (value === "index") return null;
  if (value === "restart") return "agent"; // Legacy section link.
  return value === "agent" || value === "providers" || value === "new-conversations" ? value : undefined;
};

export const stripSettingsParam = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete("settings");
  return url.href;
};

export const pushSettingsEntries = (section: SettingsSection | null): void => {
  if (ownedSettingsEntry() !== null) return;
  pushMobileHistoryEntry({ version: 1, surface: "settings", section: null, depth: 1 });
  if (section !== null) pushMobileHistoryEntry({ version: 1, surface: "settings", section, depth: 2 });
};

export const closeSettingsHistory = (): void => {
  const entry = ownedSettingsEntry();
  if (entry !== null) window.history.go(-entry.depth);
};
