export const AGENT_RAIL_DEFAULT_WIDTH = 72;
export const AGENT_RAIL_MIN_WIDTH = 72;
export const AGENT_RAIL_MAX_WIDTH = 288;
export const AGENT_RAIL_EXPANDED_WIDTH = 160;
export const AGENT_RAIL_DEFAULT_EXPANDED_WIDTH = 240;
export const AGENT_RAIL_STORAGE_KEY = "mono-agent.web.agent-rail-width";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export const clampAgentRailWidth = (width: number): number => {
  if (!Number.isFinite(width)) return AGENT_RAIL_DEFAULT_WIDTH;
  return Math.min(
    AGENT_RAIL_MAX_WIDTH,
    Math.max(AGENT_RAIL_MIN_WIDTH, Math.round(width)),
  );
};

const browserStorage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readAgentRailWidth = (
  storage: StorageReader | null = browserStorage(),
): number => {
  if (!storage) return AGENT_RAIL_DEFAULT_WIDTH;
  try {
    const stored = storage.getItem(AGENT_RAIL_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return AGENT_RAIL_DEFAULT_WIDTH;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && Number.isInteger(parsed)
      ? clampAgentRailWidth(parsed)
      : AGENT_RAIL_DEFAULT_WIDTH;
  } catch {
    return AGENT_RAIL_DEFAULT_WIDTH;
  }
};

export const writeAgentRailWidth = (
  width: number,
  storage: StorageWriter | null = browserStorage(),
): void => {
  if (!storage) return;
  try {
    storage.setItem(AGENT_RAIL_STORAGE_KEY, String(clampAgentRailWidth(width)));
  } catch {
    // Browser storage can be unavailable in private or locked-down contexts.
  }
};
