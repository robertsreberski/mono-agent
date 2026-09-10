import { decode as decodeBmp } from "bmp-ts";
import sharp from "sharp";

// Anthropic allows an 8,000 px edge per image, but drops to 2,000 px per edge as
// soon as a single request carries more than 20 image blocks — and images nested
// in tool results, plus every image replayed from an earlier turn, count toward
// that threshold. A screenshot-heavy conversation crosses 20 easily, and one
// oversized image then rejects the whole request with an invalid_request_error
// that no retry or model failover can clear. Normalize every inline image to the
// stricter ceiling so the count never matters.
//
// 2,000 px sits above the standard tier's 1,568 px native long edge and just under
// the 2,576 px high-resolution tier, so legibility is effectively unchanged: the
// provider would downscale past this point for token accounting anyway.
export const MAX_INLINE_IMAGE_EDGE_PX = 2_000;

const ANIMATED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/webp"]);
const OUTPUT_MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Cap an image's pixel dimensions to the provider-safe ceiling. Resolves to
 * `{ data, mimeType }` on success — with `data` being the source buffer itself when
 * it already fits, so callers can skip a pointless re-encode — or `{ reason }` when
 * the bytes could not be decoded. Never mutates the source.
 *
 * @param {Buffer} source
 * @param {string} imageMime
 */
export async function normalizeImageForModel(source, imageMime) {
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
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}
