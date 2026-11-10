import { safeToolImageDimensions } from "./tool-image-dimensions";

/** Tool output is untrusted. Never accept a URL or an active image MIME type. */
const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOOL_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
/** Also bounds JSON parsing and automatic full-body repairs (counts characters). */
export const MAX_TOOL_IMAGE_RESULT_CHARS = 12 * 1024 * 1024;
const MAX_IMAGES = 4;

export interface ToolResultImage {
  readonly mimeType: string;
  readonly data: string;
}
export interface ToolResultImages {
  readonly images: readonly ToolResultImage[];
  readonly remainder: unknown;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** A bounded hint only: incomplete JSON is expected in a shaped transcript. */
export function mayHaveToolImage(result: unknown): boolean {
  if (typeof result === "string") {
    return /"(?:type|kind)"\s*:\s*"image"/u.test(result.slice(0, MAX_TOOL_IMAGE_RESULT_CHARS));
  }
  const object = record(result);
  if (object?.type === "image" || object?.kind === "image") return true;
  const parts = Array.isArray(result) ? result : object?.content;
  return Array.isArray(parts) && parts.some((part) => {
    const image = record(part);
    return image?.type === "image" || image?.kind === "image";
  });
}

const base64Bytes = (data: string): number =>
  data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** Strict, canonical standard base64; no whitespace, URL alphabet, or data URLs. */
export function validToolImage(value: unknown): value is ToolResultImage {
  const image = record(value);
  if (!image || typeof image.mimeType !== "string" || !RASTER_MIMES.has(image.mimeType) || typeof image.data !== "string") return false;
  const { data } = image;
  if (data.length === 0 || data.length > Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return false;
  const bytes = base64Bytes(data);
  if (bytes > MAX_TOOL_IMAGE_BYTES) return false;
  try {
    const decoded = atob(data);
    return btoa(decoded) === data && safeToolImageDimensions(decoded, image.mimeType);
  } catch { return false; }
}

/**
 * Pi emits text interleaved with one JSON image block per line. MCP and other
 * callers can also retain a content array/object. Inspect only those explicit
 * content shapes, never arbitrary nested objects or text containing a URL.
 * Reject the entire preview on invalid/oversized image parts, retaining the
 * original text fallback rather than silently hiding any output.
 */
export function toolResultImages(result: unknown): ToolResultImages | undefined {
  return toolResultImageGroup([result]);
}

/** Cluster members retain their original result shapes and share one budget. */
export function toolResultImageGroup(results: readonly unknown[]): ToolResultImages | undefined {
  if (!results.some(mayHaveToolImage)) return undefined;
  const characters = results.reduce<number>((sum, result) => sum + (typeof result === "string" ? result.length : 0), 0);
  if (characters > MAX_TOOL_IMAGE_RESULT_CHARS) return undefined;
  const images: ToolResultImage[] = [];
  let invalid = false;
  let total = 0;
  const part = (value: unknown): unknown => {
    const object = record(value);
    if (object?.type !== "image" && object?.kind !== "image") return value;
    // Reject exhausted budgets before allocating decoded candidate bytes, and
    // stop decoding further parts once the group is already known to fail.
    if (invalid || images.length >= MAX_IMAGES || typeof object.data !== "string"
      || total + base64Bytes(object.data) > MAX_TOOL_IMAGE_TOTAL_BYTES) { invalid = true; return value; }
    if (!validToolImage(object)) { invalid = true; return value; }
    total += base64Bytes(object.data);
    images.push({ mimeType: object.mimeType, data: object.data });
    return undefined;
  };
  const content = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(part).filter((item) => item !== undefined);
    const object = record(value);
    if (Array.isArray(object?.content)) return { ...object, content: content(object.content) };
    return part(value);
  };
  const remainders = results.map((result) => {
    let remainder: unknown;
    if (typeof result === "string") {
      try {
        remainder = content(JSON.parse(result));
      } catch {
        remainder = result.split("\n").map((line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            return part(parsed) === undefined ? undefined : line;
          } catch { return line; }
        }).filter((line) => line !== undefined).join("\n");
      }
    } else {
      remainder = content(result);
    }
    return remainder === "" || (Array.isArray(remainder) && remainder.length === 0) ? undefined : remainder;
  }).filter((remainder) => remainder !== undefined);
  if (invalid || images.length === 0) return undefined;
  return { images, remainder: remainders.length <= 1 ? remainders[0] : remainders };
}

export function toolImageName(args: unknown): string {
  const object = record(args);
  const path = object?.file_path ?? object?.filePath ?? object?.path;
  return typeof path === "string" && path.length > 0
    ? (path.split(/[/\\]/u).pop() || "Tool result image").slice(0, 200)
    : "Tool result image";
}
