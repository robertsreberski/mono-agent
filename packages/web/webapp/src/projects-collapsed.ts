/**
 * Whether the dashboard's Projects section is collapsed, remembered per browser.
 *
 * One preference for the whole console, not per agent: the section lists the
 * selected agent's projects, but the collapsed choice is about the dashboard
 * chrome itself, so it survives agent switches and reloads in this browser.
 * The value is a plain `"true"`/`"false"` string under the console's
 * `mono-agent.web.*` key convention, and an absent or unreadable value means
 * expanded, which is the default for a browser that has never chosen.
 */

/** Storage key for the Projects collapsed preference, exported for tests. */
export const PROJECTS_COLLAPSED_STORAGE_KEY = "mono-agent.web.projects-collapsed";

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * The stored collapsed choice, defaulting to expanded.
 *
 * Safari private browsing and locked-down profiles throw on access, and a
 * corrupt value is indistinguishable from no choice, so every failure reads as
 * the default rather than breaking the section.
 */
export const readProjectsCollapsed = (): boolean => {
  const store = storage();
  if (store === null) return false;
  try {
    return store.getItem(PROJECTS_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

/**
 * Remember the collapsed choice for this browser.
 *
 * A quota failure throws on write, which must not break the toggle for this
 * tab: the caller already holds the new state, so a failed write is simply
 * dropped and the section keeps toggling in memory.
 */
export const writeProjectsCollapsed = (collapsed: boolean): void => {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(PROJECTS_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // The state still toggles for this tab; it just will not survive a reload.
  }
};
