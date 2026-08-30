/**
 * Which agent-published files the console renders as pictures.
 *
 * Shared because two places must agree: the part itself, which drops its file
 * card for an image, and the grouping predicate, which coalesces adjacent images
 * into one row. Two copies of this rule would drift, and the failure would be
 * silent — an image laid out as a row member while still rendering as a card.
 *
 * Raster only. `image/svg+xml` is active content: the service refuses to store
 * it and `setReplyDownloadHeaders` downgrades it to an octet stream, so it stays
 * a download here too.
 */
const REPLY_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const isReplyImage = (mediaType: unknown): boolean =>
  typeof mediaType === "string" && REPLY_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
