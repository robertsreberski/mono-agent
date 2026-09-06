import { useSyncExternalStore } from "react";

/**
 * How much this console is allowed to spend on the operator's behalf.
 *
 * The console is installed on a phone, and the phone is often on cellular. Lean
 * is the same console with everything optional made explicit: a picture arrives
 * when it is tapped, an app document when it is asked for, pages are half the
 * size, polls are half the rate. Nothing is hidden and nothing is faked — a lean
 * surface says what it has not loaded and offers to load it.
 *
 * `auto` is a reading of the browser's own Network Information API. iOS Safari
 * has none, so on the phone this console targets `auto` resolves to `full` and
 * the toggle below is the only thing that can say otherwise. That is why the
 * toggle is visible in the sidebar rather than hidden behind a settings dialog,
 * and why a home-screen install is offered Lean once.
 */
export const DATA_MODE_STORAGE_KEY = "mono-agent.web.data-mode";

/** Remembers that the standalone install has already been offered Lean once. */
export const LEAN_SUGGESTION_STORAGE_KEY = "mono-agent.web.data-mode-suggested";

export type DataModeSetting = "auto" | "lean" | "full";

/** What the setting actually resolves to. `auto` is never an answer. */
export type DataMode = "lean" | "full";

/**
 * The parts of `NetworkInformation` this console reads.
 *
 * Declared here rather than taken from the DOM lib because the API is not in
 * it: no TypeScript DOM release types `navigator.connection`, and the two fields
 * below are the whole of what a data-mode decision needs.
 */
export interface NetworkInformation {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

/** Link classes a phone is charged by the megabyte for. */
export const METERED_EFFECTIVE_TYPES: ReadonlySet<string> = new Set(["slow-2g", "2g", "3g"]);

const SETTINGS: ReadonlySet<string> = new Set<DataModeSetting>(["auto", "lean", "full"]);

/**
 * The setting, and what it means on this connection.
 *
 * An explicit choice always wins: an operator who said Lean on office wifi meant
 * it. `auto` is only ever a reading of what the browser volunteered, and a
 * browser that volunteers nothing gets `full` — the console must not quietly
 * degrade what it shows on the strength of a guess.
 */
export const resolveDataMode = (
  setting: DataModeSetting,
  connection: NetworkInformation | undefined,
): DataMode => {
  if (setting !== "auto") return setting;
  if (connection === undefined) return "full";
  if (connection.saveData === true) return "lean";
  return connection.effectiveType !== undefined && METERED_EFFECTIVE_TYPES.has(connection.effectiveType)
    ? "lean"
    : "full";
};

/** The browser's own description of the link, where it has one. */
export const networkInformation = (): NetworkInformation | undefined => {
  const value = (navigator as Navigator & { connection?: unknown }).connection;
  return value === null || typeof value !== "object" ? undefined : value as NetworkInformation;
};

const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Storage can throw outright (Safari private browsing), which is not a setting. */
const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Whether the device actually kept it. Storage can refuse outright. */
const writeStored = (key: string, value: string): boolean => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

/**
 * What this SESSION chose when the device would not remember it.
 *
 * A browser that refuses storage -- Safari private browsing, a locked-down
 * profile -- threw on the write and the read then handed back the old value, so
 * the control moved and nothing else did: the operator could not switch modes at
 * all on exactly the kind of device this feature exists for.
 *
 * Set ONLY by a failed write, and it WINS while it is set: a stale value the
 * device is refusing to overwrite is not a newer answer than the one the
 * operator just gave. It is cleared the moment a write succeeds, and by a
 * `storage` event, which is another tab genuinely saying something newer.
 */
let sessionSetting: DataModeSetting | undefined;
let offeredInSession = false;

export const readDataModeSetting = (): DataModeSetting => {
  if (sessionSetting !== undefined) return sessionSetting;
  const stored = readStored(DATA_MODE_STORAGE_KEY);
  return stored !== null && SETTINGS.has(stored) ? stored as DataModeSetting : "auto";
};

export const writeDataModeSetting = (setting: DataModeSetting): void => {
  sessionSetting = writeStored(DATA_MODE_STORAGE_KEY, setting) ? undefined : setting;
  notify();
};

/** Auto → Lean → Full → Auto: one control, every state reachable by tapping. */
export const nextDataModeSetting = (setting: DataModeSetting): DataModeSetting =>
  setting === "auto" ? "lean" : setting === "lean" ? "full" : "auto";

/**
 * How the setting reads on a control: the choice, and — for Auto — what it is
 * currently resolving to, because on iOS that answer is always Full and the
 * operator has to be able to see that before they can decide to override it.
 */
export const dataModeLabel = (setting: DataModeSetting, mode: DataMode): string =>
  setting === "auto"
    ? `Auto · ${mode === "lean" ? "Lean" : "Full"}`
    : setting === "lean" ? "Lean" : "Full";

export const cycleDataModeSetting = (): DataModeSetting => {
  const next = nextDataModeSetting(readDataModeSetting());
  writeDataModeSetting(next);
  return next;
};

/**
 * The resolved mode, for the modules that are not React components.
 *
 * Read at the moment a decision is made rather than captured, so a mode change
 * takes effect on the next request, poll or retention sweep without any of them
 * having to re-subscribe.
 */
export const currentDataMode = (): DataMode =>
  resolveDataMode(readDataModeSetting(), networkInformation());

/**
 * One set of DOM listeners for the whole document, however many components ask.
 *
 * A long transcript can hold dozens of pictures and app cards, and each of them
 * reads the mode. Registering a `storage` and a `change` listener per component
 * would put dozens of listeners on `window` for one boolean; this attaches when
 * the first subscriber arrives and detaches when the last one leaves.
 */
let detachSources: (() => void) | undefined;

/**
 * Another tab of the same console wrote something.
 *
 * The session fallback is only given up for a write that is actually ABOUT the
 * mode -- this key, or a `localStorage.clear()`, which the spec reports with a
 * null key. Any other key is a different setting entirely (the selected agent,
 * the sidebar width, the run preferences), and dropping the fallback for one of
 * those handed the control straight back to the stale value this device had
 * refused to overwrite. Every storage event still notifies: the resolved mode
 * can move for reasons other than the setting.
 */
const onStorage = (event: StorageEvent): void => {
  if (event.key === null || event.key === DATA_MODE_STORAGE_KEY) sessionSetting = undefined;
  notify();
};

const attachSources = (): void => {
  const connection = networkInformation();
  connection?.addEventListener?.("change", notify);
  window.addEventListener("storage", onStorage);
  detachSources = () => {
    connection?.removeEventListener?.("change", notify);
    window.removeEventListener("storage", onStorage);
  };
};

const subscribe = (listener: () => void): (() => void) => {
  if (listeners.size === 0) attachSources();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachSources?.();
    detachSources = undefined;
  };
};

/**
 * Told whenever the resolved mode may have moved.
 *
 * Exported for the module that has to ACT on a change rather than re-render for
 * it: the shared image store's retention bounds are read at the moment of a
 * decision, so a full → lean flip has to sweep what is already held.
 */
export const subscribeToDataMode = (listener: () => void): (() => void) => subscribe(listener);

/** The setting the operator chose, which is what a control has to show. */
export const useDataModeSetting = (): DataModeSetting =>
  useSyncExternalStore(subscribe, readDataModeSetting, readDataModeSetting);

/** What that setting means here and now. Both are strings, so both are stable. */
export const useDataMode = (): DataMode =>
  useSyncExternalStore(subscribe, currentDataMode, currentDataMode);

const standaloneDisplay = (): boolean => {
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
};

/**
 * Whether to offer Lean once.
 *
 * The case this exists for is exactly one: a home-screen install whose browser
 * cannot describe the network. There `auto` is stuck on Full however expensive
 * the link is, so the console says so once and lets the operator decide, rather
 * than either nagging or silently choosing for them.
 */
export const shouldOfferLeanDataMode = (): boolean =>
  readDataModeSetting() === "auto"
  && networkInformation() === undefined
  && standaloneDisplay()
  && !offeredInSession
  && readStored(LEAN_SUGGESTION_STORAGE_KEY) === null;

export const markLeanDataModeOffered = (): void => {
  // Remembered in memory as well, for the same reason as the setting: on a
  // device that refuses storage the write is a no-op, and without this the
  // offer would reappear on every render for the rest of the session.
  offeredInSession = true;
  writeStored(LEAN_SUGGESTION_STORAGE_KEY, "offered");
};

/** Test hook: this module owns document-lifetime state by design. */
export const resetDataModeSession = (): void => {
  sessionSetting = undefined;
  offeredInSession = false;
  notify();
};
