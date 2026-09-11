/**
 * Unsent prompt text, kept per agent and conversation and retained on the
 * device.
 *
 * Only one composer is visible at a time, while every conversation the operator
 * visits may hold an unfinished thought, so the working registry below is keyed
 * by agent and conversation. It is also the console's authoritative copy while a
 * tab is open: reads and writes happen on every keystroke and must not touch
 * storage that can block.
 *
 * Text additionally OUTLIVES the tab. The console is installed on a phone, where
 * the app is closed and evicted from memory constantly, and a registry that
 * lived only in tab memory lost whatever had been typed every time that
 * happened. Persistence is therefore a real browser-storage contract: authored
 * prompt text sits in this origin's `localStorage`, in the clear, until it is
 * sent, cleared, evicted or expires. Anything with access to the browser profile
 * can read it. Nothing is uploaded, and there is no cross-device sync — a draft
 * belongs to the browser it was typed in.
 *
 * Attachments stay owned by the visible assistant-ui runtime: switching context
 * disposes their upload reservations instead of retaining them here, and their
 * bytes are not restorable across a reload.
 */

/** One JSON document, so a prune is one write and a corrupt value is one discard. */
export const COMPOSER_DRAFTS_STORAGE_KEY = "mono-agent.web.composer-drafts";

/** Long enough for any prompt actually typed into a phone composer. */
const MAX_DRAFT_CHARACTERS = 32_768;
/** Conversations retained; the oldest are evicted first. */
const MAX_DRAFTS = 40;
/** A draft nobody returned to within a month is abandoned, not unfinished. */
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** Keystrokes are cheap; a synchronous serialize per keystroke is not. */
const FLUSH_DELAY_MS = 500;

interface DraftEntry {
  readonly text: string;
  /** Epoch milliseconds of the last edit, used for eviction and expiry. */
  readonly updatedAt: number;
}

const textDrafts = new Map<string, DraftEntry>();
let visibleAttachments = false;

/**
 * Keys this tab has written or deleted since it hydrated.
 *
 * A flush must not simply overwrite the stored document: another tab may hold a
 * draft this one never saw, and this one may have SENT a draft that tab still
 * lists. Merging per key — stored entries win for keys this tab never touched,
 * this tab wins for the keys it did, including deletions — keeps both facts.
 */
const touchedKeys = new Set<string>();

let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Whether the device is actually keeping drafts.
 *
 * Safari private browsing and locked-down profiles throw on `localStorage`
 * access outright, and a full quota refuses the write. Text is then tab-memory
 * only again, which the staged-update guard below has to know about.
 */
let persisting = true;

export const composerDraftKey = (
  sourceId: string | null,
  threadId: string | null,
): string | null => sourceId === null ? null : JSON.stringify([sourceId, threadId]);

let lastStamp = 0;

/**
 * Edit time, forced to move.
 *
 * Eviction and cross-tab merging both order by this, and a clock with
 * millisecond resolution hands out ties freely — typing quickly across
 * conversations produced entries the cap could not tell apart, and the eviction
 * then dropped the newest. Staying within a few milliseconds of the real clock
 * keeps expiry honest and remains comparable with what another tab wrote.
 */
const stamp = (): number => {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
};

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const isStoredDraft = (value: unknown): value is { key: string; text: string; updatedAt: number } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.key === "string"
    && candidate.key.length > 0
    && candidate.key.length <= 8_192
    && typeof candidate.text === "string"
    && candidate.text.length > 0
    && candidate.text.length <= MAX_DRAFT_CHARACTERS
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt);
};

/** Parse the stored document, discarding anything this version cannot trust. */
/**
 * The stored document, with any stamp from the future read as "now".
 *
 * `onClamped` hears which keys that touched: a clamp is a correction, and the
 * caller that hydrates from it has to own it, or the next merge would read the
 * same future stamp as a fresher "now" and let the draft outrank every edit
 * typed since.
 */
const readStored = (onClamped?: (key: string) => void): Map<string, DraftEntry> => {
  const entries = new Map<string, DraftEntry>();
  const store = storage();
  if (store === null) {
    persisting = false;
    return entries;
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(COMPOSER_DRAFTS_STORAGE_KEY);
  } catch {
    persisting = false;
    return entries;
  }
  if (raw === null) return entries;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Invalid composer drafts.");
    }
    const document = parsed as Record<string, unknown>;
    if (document.version !== 1 || !Array.isArray(document.drafts)) {
      throw new TypeError("Unsupported composer drafts.");
    }
    const now = Date.now();
    const expiredBefore = now - MAX_DRAFT_AGE_MS;
    for (const value of document.drafts) {
      if (!isStoredDraft(value)) throw new TypeError("Invalid composer draft.");
      if (value.updatedAt < expiredBefore) continue;
      // A stamp from the future is a clock that was wrong when it was written.
      // Left alone it would outrank everything typed afterwards and survive
      // every eviction; read as "now" it keeps its place at the front and
      // expires on schedule.
      if (value.updatedAt > now) onClamped?.(value.key);
      entries.set(value.key, { text: value.text, updatedAt: Math.min(value.updatedAt, now) });
    }
  } catch {
    try {
      store.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    } catch {
      persisting = false;
    }
    return new Map();
  }
  return entries;
};

/** Newest first, so eviction drops the drafts least likely to be wanted. */
const serialize = (entries: Map<string, DraftEntry>): string => {
  const drafts = [...entries.entries()]
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DRAFTS)
    .map(([key, entry]) => ({ key, text: entry.text, updatedAt: entry.updatedAt }));
  return JSON.stringify({ version: 1, drafts });
};

const write = (store: Storage, entries: Map<string, DraftEntry>): boolean => {
  try {
    if (entries.size === 0) store.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    else store.setItem(COMPOSER_DRAFTS_STORAGE_KEY, serialize(entries));
    return true;
  } catch {
    return false;
  }
};

/**
 * Write the merged document now.
 *
 * Called on a timer during typing and synchronously when the page is being torn
 * down, which on iOS is the only warning this console gets.
 */
export const flushComposerDrafts = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (touchedKeys.size === 0) return;
  const store = storage();
  if (store === null) {
    persisting = false;
    return;
  }
  const merged = readStored();
  for (const key of touchedKeys) {
    const entry = textDrafts.get(key);
    if (entry === undefined) merged.delete(key);
    else merged.set(key, entry);
  }
  if (write(store, merged)) {
    touchedKeys.clear();
    persisting = true;
    return;
  }
  // A refused write is usually a full quota. Drop everything this tab is not
  // holding and try once more; a device that still says no keeps the text in
  // memory, and the staged-update guard stops trusting storage.
  const own = new Map<string, DraftEntry>();
  for (const key of touchedKeys) {
    const entry = textDrafts.get(key);
    if (entry !== undefined) own.set(key, entry);
  }
  if (write(store, own)) {
    touchedKeys.clear();
    persisting = true;
    return;
  }
  persisting = false;
};

const scheduleFlush = (): void => {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushComposerDrafts();
  }, FLUSH_DELAY_MS);
  // Never hold a Node test process open on a pending draft write.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Teardown listeners.
 *
 * `pagehide` and a `visibilitychange` to hidden are the events a mobile browser
 * actually delivers when the operator swipes the app away or the system evicts
 * it; `beforeunload` is not dispatched in that path on iOS. Both are registered
 * once, and both flush synchronously.
 */
let listening = false;

const listenForTeardown = (): void => {
  if (listening || typeof window === "undefined" || typeof document === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", flushComposerDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushComposerDrafts();
  });
};

const hydrate = (): void => {
  if (hydrated) return;
  hydrated = true;
  // A clamped stamp is this tab's edit of the record: written back at the next
  // flush, so the merge takes this hydration's "now" and not a later one.
  for (const [key, entry] of readStored((key) => touchedKeys.add(key))) {
    textDrafts.set(key, entry);
    // Anything typed from here has to outrank what is already stored, even
    // where the device clock has since moved backwards; otherwise eviction
    // would keep old drafts and drop the one being written right now.
    lastStamp = Math.max(lastStamp, entry.updatedAt);
  }
  listenForTeardown();
};

/** The exact text last observed for this agent/conversation context. */
export const readComposerDraft = (
  sourceId: string | null,
  threadId: string | null,
): string => {
  hydrate();
  const key = composerDraftKey(sourceId, threadId);
  return key === null ? "" : textDrafts.get(key)?.text ?? "";
};

/** Mirror exact text, pruning whitespace-only entries from the registry. */
export const writeComposerDraft = (
  sourceId: string | null,
  threadId: string | null,
  text: string,
): void => {
  hydrate();
  const key = composerDraftKey(sourceId, threadId);
  if (key === null) return;
  const current = textDrafts.get(key);
  if (text.trim().length === 0) {
    if (current === undefined) return;
    textDrafts.delete(key);
    touchedKeys.add(key);
    // A send or a clear is written NOW. Debouncing a removal risks the app being
    // killed in that window and handing the operator back a message they had
    // already sent.
    flushComposerDrafts();
    return;
  }
  // An oversized paste is retained in the tab exactly as typed; only what the
  // device keeps is truncated, and it is truncated rather than dropped so the
  // operator gets the thought back instead of nothing.
  const retained = text.length > MAX_DRAFT_CHARACTERS ? text.slice(0, MAX_DRAFT_CHARACTERS) : text;
  if (current?.text === retained) return;
  textDrafts.set(key, { text: retained, updatedAt: stamp() });
  touchedKeys.add(key);
  scheduleFlush();
};

/** Move the new-conversation bucket onto the exact thread the server created. */
export const transferComposerDraft = (
  sourceId: string,
  fromThreadId: string | null,
  toThreadId: string,
): void => {
  hydrate();
  const from = composerDraftKey(sourceId, fromThreadId);
  const to = composerDraftKey(sourceId, toThreadId);
  if (from === null || to === null || from === to) return;
  const entry = textDrafts.get(from);
  textDrafts.delete(from);
  if (entry !== undefined) textDrafts.set(to, entry);
  touchedKeys.add(from);
  touchedKeys.add(to);
  scheduleFlush();
};

/** Forget prompt text only once deletion is authoritative. */
export const forgetComposerDraft = (
  sourceId: string,
  threadId: string,
): void => {
  hydrate();
  const key = composerDraftKey(sourceId, threadId);
  if (key === null) return;
  textDrafts.delete(key);
  touchedKeys.add(key);
  flushComposerDrafts();
};

/** Attachments are not restorable, but still make a service-worker reload unsafe. */
export const noteComposerAttachments = (hasAttachments: boolean): void => {
  visibleAttachments = hasAttachments;
};

/** Whether anything is typed or staged and not yet sent. */
export const hasUnsentComposerDraft = (): boolean =>
  textDrafts.size > 0 || visibleAttachments;

/**
 * Whether a reload would destroy composer content that nothing puts back.
 *
 * Persisted text survives a reload and must not defer a new build forever — a
 * draft left in one conversation would otherwise pin this console to an old
 * shell indefinitely. Two things still do defer it: staged attachments, whose
 * bytes live in the assistant-ui runtime alone, and text on a device that
 * refused to store it.
 */
export const hasUnrecoverableComposerContent = (): boolean =>
  visibleAttachments || (textDrafts.size > 0 && !persisting);

/** Test/app teardown hook: forgets the drafts here AND on the device. */
export const resetComposerDraft = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  textDrafts.clear();
  touchedKeys.clear();
  visibleAttachments = false;
  hydrated = false;
  persisting = true;
  lastStamp = 0;
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
  } catch {
    // A storage that refuses removal has nothing this console can do about it.
  }
};
