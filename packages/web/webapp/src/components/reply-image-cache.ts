import { currentDataMode } from "../data-mode";
import { recordTransferredBody } from "../data-usage";

/**
 * One object URL per picture, and one request for it, shared by every view.
 *
 * A reply image with no durable copy is fetched through a capability URL, so its
 * bytes cannot be re-read from the HTTP cache: the token in the URL is re-minted
 * on every projection, which makes each mint a fresh cache key. Holding the blob
 * here instead means scrolling a picture out of view, switching conversations,
 * or re-rendering a message costs nothing on the wire.
 *
 * Object URLs are document-scoped and are never collected on their own, so this
 * store is reference-counted: the last release starts a short retention window
 * rather than revoking immediately, and what nobody holds is bounded by BOTH a
 * count and a byte ceiling. The bytes matter more than the count — the console
 * is installed on a phone, and a couple of dozen full-size generated images is
 * an out-of-memory kill rather than a slow scroll.
 */

/** How long an image nobody is showing stays available for a remount. */
export const REPLY_IMAGE_RETENTION_MS = 60_000;

/** How many unreferenced images may wait out that window at once. */
export const REPLY_IMAGE_RETENTION_LIMIT = 24;

/** And how many of their bytes, which is the bound that actually binds. */
export const REPLY_IMAGE_RETENTION_BYTES = 32 * 1024 * 1024;

/**
 * The same three bounds for a device on a data diet.
 *
 * Retention trades memory for network, and a lean console is being run on the
 * phone where memory is the scarcer of the two -- so it keeps a third as long, a
 * third as many, and a quarter of the bytes. A picture evicted early costs one
 * fetch if the operator scrolls back to it; a phone out of memory costs the tab.
 */
export const LEAN_REPLY_IMAGE_RETENTION_MS = 20_000;
export const LEAN_REPLY_IMAGE_RETENTION_LIMIT = 8;
export const LEAN_REPLY_IMAGE_RETENTION_BYTES = 8 * 1024 * 1024;

/**
 * Read at the moment of the decision, never captured: the operator can change
 * the mode between one picture arriving and the next being released.
 */
const lean = (): boolean => currentDataMode() === "lean";

export const replyImageRetentionMs = (): number =>
  lean() ? LEAN_REPLY_IMAGE_RETENTION_MS : REPLY_IMAGE_RETENTION_MS;

export const replyImageRetentionLimit = (): number =>
  lean() ? LEAN_REPLY_IMAGE_RETENTION_LIMIT : REPLY_IMAGE_RETENTION_LIMIT;

export const replyImageRetentionBytes = (): number =>
  lean() ? LEAN_REPLY_IMAGE_RETENTION_BYTES : REPLY_IMAGE_RETENTION_BYTES;

/**
 * How long one picture's request may take before it is abandoned.
 *
 * Same reasoning as the console's other bounded reads (`THREAD_READ_TIMEOUT_MS`):
 * a request on a wedged transport never rejects on its own, and an image that
 * hangs forever is a placeholder that never becomes the file card the operator
 * could have downloaded instead.
 */
export const REPLY_IMAGE_REQUEST_TIMEOUT_MS = 30_000;

interface SharedReplyImage {
  readonly objectUrl: string;
  readonly size: number;
  refs: number;
  timer: number | undefined;
}

interface SharedReplyImageRequest {
  readonly controller: AbortController;
  /** Closes this request's slot and its deadline, however often it is called. */
  readonly settle: () => void;
  readonly promise: Promise<Blob>;
  waiters: number;
}

const sharedImages = new Map<string, SharedReplyImage>();
/** Keys with no viewer, least recently released first. */
const retained: string[] = [];
let retainedBytes = 0;
const inFlight = new Map<string, SharedReplyImageRequest>();

/**
 * Takes one key out of the queue and its bytes off the total.
 *
 * The size is passed in from the entry the caller already has rather than read
 * back out of the map: reading it back made the arithmetic depend on whether the
 * caller had deleted the entry yet, and the caller that had — the retention
 * timer, which is how every released picture normally ends — subtracted nothing.
 * The leak then ate the whole ceiling and every release evicted what it had just
 * retained, so the window stopped existing for the life of the document.
 */
const forgetRetained = (key: string, size: number): void => {
  const at = retained.indexOf(key);
  if (at === -1) return;
  retained.splice(at, 1);
  retainedBytes -= size;
};

const revokeShared = (key: string): void => {
  const image = sharedImages.get(key);
  if (image === undefined || image.refs > 0) return;
  if (image.timer !== undefined) window.clearTimeout(image.timer);
  sharedImages.delete(key);
  forgetRetained(key, image.size);
  URL.revokeObjectURL(image.objectUrl);
};

/**
 * Frees what nobody is holding until both bounds hold again.
 *
 * The queue entry is removed before anything else runs, so the loop makes
 * progress on every pass whatever the entry turns out to be.
 */
const evictRetained = (): void => {
  const countBound = replyImageRetentionLimit();
  const byteBound = replyImageRetentionBytes();
  while (retained.length > countBound || retainedBytes > byteBound) {
    const oldest = retained.shift();
    if (oldest === undefined) break;
    // The entry is read ONCE and the decrement comes off it, exactly as
    // `forgetRetained` takes the size from the caller's entry: nothing here
    // depends on whether the map still holds the key by the time it runs.
    const image = sharedImages.get(oldest);
    if (image === undefined) continue;
    retainedBytes -= image.size;
    revokeShared(oldest);
  }
};

/** Everything the store is holding for nobody, in bytes. Tests read it. */
export const retainedReplyImageBytes = (): number => retainedBytes;

const hold = (image: SharedReplyImage, key: string): string => {
  image.refs += 1;
  if (image.timer !== undefined) {
    window.clearTimeout(image.timer);
    image.timer = undefined;
  }
  forgetRetained(key, image.size);
  return image.objectUrl;
};

/**
 * Content identity, not part identity: the same bytes published to two messages
 * are one picture. The declared length rides along because the hash is a claim
 * made in the same payload as everything else — two parts that disagree about
 * how long the same hash is must never share a blob.
 */
export const replyImageKey = (integrityId: string, sizeBytes: number): string =>
  `${integrityId} ${sizeBytes}`;

/** The shared object URL for content already held, taking a reference on it. */
export const acquireReplyImageBlob = (key: string): string | undefined => {
  const image = sharedImages.get(key);
  return image === undefined ? undefined : hold(image, key);
};

/** Publishes fetched bytes under `key`, taking a reference on the result. */
export const publishReplyImageBlob = (key: string, blob: Blob): string => {
  const existing = sharedImages.get(key);
  if (existing !== undefined) return hold(existing, key);
  // This is the one call that sees a picture's bytes arrive: a second viewer of
  // the same content joins above and is charged nothing, and a picture resolved
  // out of retention never reaches here at all. An estimate only -- silent
  // wherever the browser is measuring the transfer itself.
  recordTransferredBody(blob.size);
  const objectUrl = URL.createObjectURL(blob);
  sharedImages.set(key, { objectUrl, size: blob.size, refs: 1, timer: undefined });
  return objectUrl;
};

/** Drops one reference; the last one starts the retention window. */
export const releaseReplyImageBlob = (key: string): void => {
  const image = sharedImages.get(key);
  if (image === undefined || image.refs === 0) return;
  image.refs -= 1;
  if (image.refs > 0) return;
  retained.push(key);
  retainedBytes += image.size;
  image.timer = window.setTimeout(() => revokeShared(key), replyImageRetentionMs());
  evictRetained();
};

/**
 * Joins the request already in flight for this content, or starts one.
 *
 * Two parts can carry the same picture in one conversation — a message and the
 * job card that published it — and they mount together. Without this they would
 * each spend a download of the same bytes to arrive at the same blob.
 *
 * The request belongs to the store rather than to any one viewer: it is
 * abandoned when the last waiter leaves, or when its deadline passes, and never
 * because one of several viewers scrolled away.
 */
export const joinReplyImageFetch = (
  key: string,
  start: (signal: AbortSignal) => Promise<Blob>,
): Promise<Blob> => {
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    existing.waiters += 1;
    return existing.promise;
  }
  const controller = new AbortController();
  let timer: number | undefined = window.setTimeout(
    () => controller.abort(new DOMException("The reply image request timed out.", "TimeoutError")),
    REPLY_IMAGE_REQUEST_TIMEOUT_MS,
  );
  // Both the last waiter leaving and the request answering close this slot, and
  // either can come first, so the deadline is owned here and cleared once.
  const settle = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
  };
  const promise = (async () => {
    try {
      return await start(controller.signal);
    } finally {
      settle();
    }
  })();
  // Nothing is left unhandled if every waiter leaves before it settles.
  promise.catch(() => undefined);
  inFlight.set(key, { controller, settle, promise, waiters: 1 });
  return promise;
};

/**
 * Drops one waiter; the last one to leave abandons the request.
 *
 * The request it was waiting on is named, not just its key: a viewer whose own
 * request finished long ago must not be able to abandon the one a later viewer
 * started for the same picture.
 */
export const dropReplyImageFetch = (key: string, request: Promise<Blob>): void => {
  const pending = inFlight.get(key);
  if (pending === undefined || pending.promise !== request) return;
  pending.waiters -= 1;
  if (pending.waiters > 0) return;
  pending.settle();
  pending.controller.abort(new DOMException("The reply image is no longer shown.", "AbortError"));
};

/**
 * Revokes every shared image and abandons every shared request.
 *
 * Object URLs belong to the document that minted them, so a test that installs
 * its own `URL.createObjectURL` must be able to leave nothing behind for the
 * next one; without this, one case's picture would satisfy another case's fetch.
 */
export const clearReplyImageBlobs = (): void => {
  for (const [key, image] of sharedImages) {
    if (image.timer !== undefined) window.clearTimeout(image.timer);
    sharedImages.delete(key);
    URL.revokeObjectURL(image.objectUrl);
  }
  retained.length = 0;
  retainedBytes = 0;
  for (const request of [...inFlight.values()]) {
    request.settle();
    request.controller.abort(new DOMException("The reply image is no longer shown.", "AbortError"));
  }
};
