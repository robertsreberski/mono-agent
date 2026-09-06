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
  readonly timer: number;
  readonly promise: Promise<Blob>;
  waiters: number;
}

const sharedImages = new Map<string, SharedReplyImage>();
/** Keys with no viewer, least recently released first. */
const retained: string[] = [];
let retainedBytes = 0;
const inFlight = new Map<string, SharedReplyImageRequest>();

const forgetRetained = (key: string): void => {
  const at = retained.indexOf(key);
  if (at === -1) return;
  retained.splice(at, 1);
  retainedBytes -= sharedImages.get(key)?.size ?? 0;
};

const revokeShared = (key: string): void => {
  const image = sharedImages.get(key);
  if (image === undefined || image.refs > 0) return;
  if (image.timer !== undefined) window.clearTimeout(image.timer);
  sharedImages.delete(key);
  forgetRetained(key);
  URL.revokeObjectURL(image.objectUrl);
};

/**
 * Frees what nobody is holding until both bounds hold again.
 *
 * The queue entry is removed before anything else runs, so the loop makes
 * progress on every pass whatever the entry turns out to be.
 */
const evictRetained = (): void => {
  while (retained.length > REPLY_IMAGE_RETENTION_LIMIT || retainedBytes > REPLY_IMAGE_RETENTION_BYTES) {
    const oldest = retained.shift();
    if (oldest === undefined) break;
    retainedBytes -= sharedImages.get(oldest)?.size ?? 0;
    revokeShared(oldest);
  }
};

const hold = (image: SharedReplyImage, key: string): string => {
  image.refs += 1;
  if (image.timer !== undefined) {
    window.clearTimeout(image.timer);
    image.timer = undefined;
  }
  forgetRetained(key);
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
  image.timer = window.setTimeout(() => revokeShared(key), REPLY_IMAGE_RETENTION_MS);
  evictRetained();
};

/** Closes out one request's slot, but only while that request still owns it. */
const settleRequest = (key: string, controller: AbortController, timer: number): void => {
  window.clearTimeout(timer);
  if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
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
  const timer = window.setTimeout(
    () => controller.abort(new DOMException("The reply image request timed out.", "TimeoutError")),
    REPLY_IMAGE_REQUEST_TIMEOUT_MS,
  );
  const promise = (async () => {
    try {
      return await start(controller.signal);
    } finally {
      settleRequest(key, controller, timer);
    }
  })();
  // Nothing is left unhandled if every waiter leaves before it settles.
  promise.catch(() => undefined);
  inFlight.set(key, { controller, timer, promise, waiters: 1 });
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
  settleRequest(key, pending.controller, pending.timer);
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
  for (const [key, request] of inFlight) {
    settleRequest(key, request.controller, request.timer);
    request.controller.abort(new DOMException("The reply image is no longer shown.", "AbortError"));
  }
};
