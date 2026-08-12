import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { decode as decodeBmp } from "bmp-ts";
import sharp from "sharp";
import {
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_READ_LINES,
  MAX_READ_LINES,
} from "./shared/constants.js";
import { boundedInt, rememberRead, trimLine } from "./shared/dedup.js";
import { capChars } from "./shared/output-truncation.js";
import { isPathAllowed, resolveToolPath } from "./shared/path-resolver.js";

// Raster image formats a vision model can consume directly. SVG is intentionally
// excluded — it is XML text, so it stays on the line-numbered text path.
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

// Anthropic rejects images with an edge longer than 8,000 px. Normalize Read
// results to that shared provider-safe ceiling before the tool-result byte cap
// runs, while leaving the source file untouched.
const MAX_INLINE_IMAGE_EDGE_PX = 8_000;
const ANIMATED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/webp"]);
const OUTPUT_MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * @param {string} target
 * @param {string} filePath
 * @param {string} imageMime
 */
async function readImageForModel(target, filePath, imageMime) {
  const source = readFileSync(target);
  const inputOptions = { animated: ANIMATED_IMAGE_MIME_TYPES.has(imageMime) };

  try {
    let width;
    let height;
    let createPipeline;

    if (imageMime === "image/bmp") {
      // The prebuilt Sharp binaries do not include a BMP loader. Decode to raw
      // RGBA first, then let Sharp handle the provider-safe resize and PNG output.
      const decoded = decodeBmp(source, { toRGBA: true });
      width = decoded.width;
      height = Math.abs(decoded.height);
      createPipeline = () => sharp(decoded.data, {
        raw: { width, height, channels: 4 },
      });
    } else {
      const metadata = await sharp(source, inputOptions).metadata();
      width = metadata.width;
      // Sharp exposes animated images as a vertical stack internally. Providers
      // care about the dimensions of each frame, not the height of that stack.
      height = metadata.pageHeight ?? metadata.height;
      createPipeline = () => sharp(source, inputOptions);
    }

    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error("could not determine positive pixel dimensions");
    }

    if (width <= MAX_INLINE_IMAGE_EDGE_PX && height <= MAX_INLINE_IMAGE_EDGE_PX) {
      return { data: source, mimeType: imageMime };
    }

    let pipeline = createPipeline()
      .autoOrient()
      .resize({
        width: MAX_INLINE_IMAGE_EDGE_PX,
        height: MAX_INLINE_IMAGE_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      });

    // Sharp cannot emit BMP, so resized BMP input becomes lossless PNG.
    if (imageMime === "image/bmp") pipeline = pipeline.png();

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const mimeType = OUTPUT_MIME_BY_FORMAT[info.format];
    if (mimeType === undefined) {
      throw new Error(`unsupported normalized image format: ${info.format}`);
    }
    return { data, mimeType };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `Error: Unable to read image ${filePath}: ${reason}` };
  }
}

/**
 * @param {{file_path: string, offset?: number, start_line?: number, limit?: number, max_output_chars?: number, workdir?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any}} [options]
 */
export async function readToolImpl({ file_path, offset = 0, start_line, limit, max_output_chars, workdir }, { sandboxPolicy, ctx } = {}) {
  const target = resolveToolPath(file_path, workdir, ctx);
  if (!isPathAllowed(target, workdir, { sandboxPolicy, ctx })) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  // Image files are returned as an image result so vision models see pixels
  // rather than the raw bytes decoded (and garbled) as utf8 text. The builtin
  // tool wrapper turns this into an image content block; oversize images are
  // capped by the shared tool-result bloat guard.
  const imageMime = IMAGE_MIME_BY_EXT[extname(target).toLowerCase()];
  if (imageMime !== undefined) {
    const image = await readImageForModel(target, file_path, imageMime);
    if (image.error !== undefined) return image.error;
    return { kind: "image", data: image.data.toString("base64"), mimeType: image.mimeType };
  }
  const content = readFileSync(target, "utf8");
  let lines = content.split("\n");
  const total = lines.length;
  const explicitStartLine = Number(start_line);
  const start = Number.isInteger(explicitStartLine) && explicitStartLine > 0
    ? explicitStartLine - 1
    : Math.max(0, Number(offset) || 0);
  const requested = limit == null
    ? DEFAULT_READ_LINES
    : boundedInt(limit, DEFAULT_READ_LINES, { min: 1, max: MAX_READ_LINES });
  const requestedExceeded = limit != null && Number(limit) > MAX_READ_LINES;
  lines = lines.slice(start, start + requested);
  const repeated = rememberRead(target, start, requested);
  const numbered = lines.map((line, i) => `${start + i + 1}\t${trimLine(line)}`).join("\n");
  const nextLine = start + lines.length + 1;
  const notes = [];
  if (requestedExceeded) notes.push(`Requested limit was capped at ${MAX_READ_LINES} lines.`);
  if (nextLine <= total) notes.push(`Next unread line: ${nextLine}. Continue with offset=${nextLine - 1} or start_line=${nextLine}.`);
  if (repeated) notes.push("This exact file range was already read in this process; use a narrower or later range if you need new context.");
  return capChars(`${numbered}${notes.length ? `\n\n${notes.join("\n")}` : ""}`, {
    label: "Read",
    maxChars: Number(max_output_chars) || DEFAULT_MAX_READ_CHARS,
    hint: "Use Read with offset/start_line and limit for the specific range you need.",
    ctx,
  });
}
