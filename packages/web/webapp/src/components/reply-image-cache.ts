/**
 * One object URL per picture, shared by every view of it and outliving them.
 *
 * A reply image with no durable copy is fetched through a capability URL, so its
 * bytes cannot be re-read from the HTTP cache: the token in the URL is re-minted
 * on every projection, which makes each mint a fresh cache key. Holding the blob
 * here instead means scrolling a picture out of view, switching conversations,
 * or re-rendering a message costs nothing on the wire.
 *
 * Object URLs are document-scoped and are never collected on their own, so this
 * store is reference-counted: the last release starts a short retention window
 * rather than revoking immediately, and what nobody holds is bounded so a long
 * session cannot accumulate images no one is looking at.
 */

/** How long an image nobody is showing stays available for a remount. */
export const REPLY_IMAGE_RETENTION_MS = 60_000;

/** How many unreferenced images may wait out that window at once. */
const REPLY_IMAGE_RETENTION_LIMIT = 24;

interface SharedReplyImage {
  readonly objectUrl: string;
  refs: number;
  timer: number | undefined;
}

const sharedImages = new Map<string, SharedReplyImage>();
/** Keys with no viewer, least recently released first. */
const retained: string[] = [];

const forget = (key: string): void => {
  const at = retained.indexOf(key);
  if (at !== -1) retained.splice(at, 1);
};

const revokeShared = (key: string): void => {
  const image = sharedImages.get(key);
  if (image === undefined || image.refs > 0) return;
  if (image.timer !== undefined) window.clearTimeout(image.timer);
  sharedImages.delete(key);
  forget(key);
  URL.revokeObjectURL(image.objectUrl);
};

const hold = (image: SharedReplyImage, key: string): string => {
  image.refs += 1;
  if (image.timer !== undefined) {
    window.clearTimeout(image.timer);
    image.timer = undefined;
  }
  forget(key);
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
  sharedImages.set(key, { objectUrl, refs: 1, timer: undefined });
  return objectUrl;
};

/** Drops one reference; the last one starts the retention window. */
export const releaseReplyImageBlob = (key: string): void => {
  const image = sharedImages.get(key);
  if (image === undefined || image.refs === 0) return;
  image.refs -= 1;
  if (image.refs > 0) return;
  retained.push(key);
  image.timer = window.setTimeout(() => revokeShared(key), REPLY_IMAGE_RETENTION_MS);
  while (retained.length > REPLY_IMAGE_RETENTION_LIMIT) {
    const oldest = retained[0];
    if (oldest === undefined) break;
    revokeShared(oldest);
  }
};

/**
 * Revokes every shared image at once.
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
};
