import { describe, expect, it, vi } from "vitest";
import { TOOL_IMAGE } from "../test/tool-image-fixture";
import { MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_TOTAL_BYTES, MAX_TOOL_IMAGE_RESULT_CHARS, mayHaveToolImage, toolImageName, toolResultImages, toolResultImageGroup, validToolImage } from "./tool-result-images";
import { safeToolImageDimensions } from "./tool-image-dimensions";

const rawImage = { kind: "image", data: TOOL_IMAGE.data, mimeType: TOOL_IMAGE.mimeType };
const paddedImage = (bytes: number) => {
  const png = atob(TOOL_IMAGE.data);
  return { ...TOOL_IMAGE, data: btoa(png + "\0".repeat(bytes - png.length)) };
};

describe("tool image output", () => {
  it("reads inline JSON, JSON lines, content arrays, and Read's raw shape", () => {
    for (const result of [TOOL_IMAGE, JSON.stringify(TOOL_IMAGE), [TOOL_IMAGE], { content: [TOOL_IMAGE] }, rawImage, [rawImage], { content: [rawImage] }]) {
      expect(toolResultImages(result)?.images).toEqual([{ data: TOOL_IMAGE.data, mimeType: "image/png" }]);
    }
    expect(toolResultImages(`caption\n${JSON.stringify(TOOL_IMAGE)}\nmore`)?.remainder).toBe("caption\nmore");
    expect(toolResultImages({ content: [{ type: "text", text: "caption" }, TOOL_IMAGE], metadata: 1 })?.remainder)
      .toEqual({ content: [{ type: "text", text: "caption" }], metadata: 1 });
  });
  it("recognizes incomplete image JSON only as a repair hint", () => {
    const head = JSON.stringify(TOOL_IMAGE).slice(0, 100);
    expect(mayHaveToolImage(head)).toBe(true);
    expect(toolResultImages(head)).toBeUndefined();
  });
  it.each(["image/svg+xml", "text/html", "image/avif", "image/png;foo=bar", "https://example.invalid/image.png"])("rejects MIME %s", (mimeType) => {
    expect(toolResultImages({ ...TOOL_IMAGE, mimeType })).toBeUndefined();
  });
  it.each(["", "abcd=", "ab-c", "a b c", "YWJj\n", "data:image/png;base64,YWJj", "Zh==", "!!!!", "YWJj"])("rejects malformed base64 or non-raster bytes %s", (data) => {
    expect(validToolImage({ ...TOOL_IMAGE, data })).toBe(false);
  });
  it("bounds bytes, count, aggregate bytes, parsing and pixel dimensions", () => {
    const overLimit = paddedImage(MAX_TOOL_IMAGE_BYTES + 1);
    expect(safeToolImageDimensions(atob(overLimit.data), overLimit.mimeType)).toBe(true);
    expect(validToolImage(paddedImage(MAX_TOOL_IMAGE_BYTES))).toBe(true);
    expect(validToolImage(overLimit)).toBe(false);
    expect(toolResultImages(Array.from({ length: 5 }, () => TOOL_IMAGE))).toBeUndefined();
    const padded = { ...TOOL_IMAGE, data: btoa(atob(TOOL_IMAGE.data) + "\0".repeat(3 * 1024 * 1024)) };
    expect(toolResultImages([padded, padded, padded])).toBeUndefined();
    expect(toolResultImages(JSON.stringify(TOOL_IMAGE) + " ".repeat(MAX_TOOL_IMAGE_RESULT_CHARS))).toBeUndefined();
    const bytes = atob(TOOL_IMAGE.data);
    const huge = bytes.slice(0, 16) + "\x00\x01\x00\x00\x00\x01\x00\x00" + bytes.slice(24);
    expect(validToolImage({ ...TOOL_IMAGE, data: btoa(huge) })).toBe(false);
    expect(toolResultImages([TOOL_IMAGE, { ...TOOL_IMAGE, data: "invalid" }])).toBeUndefined();
  });
  it("counts padded images exactly at the aggregate byte boundary", () => {
    const half = paddedImage(MAX_TOOL_IMAGE_TOTAL_BYTES / 2);
    expect(half.data.endsWith("==")).toBe(true);
    expect(toolResultImages([half, half])?.images).toHaveLength(2);
    expect(toolResultImages([half, paddedImage(MAX_TOOL_IMAGE_TOTAL_BYTES / 2 - 1)])?.images).toHaveLength(2);
  });
  it("rejects exhausted count and byte budgets before decoding more candidates", () => {
    const half = paddedImage(MAX_TOOL_IMAGE_TOTAL_BYTES / 2);
    const overHalf = paddedImage(MAX_TOOL_IMAGE_TOTAL_BYTES / 2 + 1);
    const decode = vi.spyOn(globalThis, "atob");
    try {
      expect(toolResultImages(Array.from({ length: 6 }, () => TOOL_IMAGE))).toBeUndefined();
      expect(decode).toHaveBeenCalledTimes(4);
      decode.mockClear();
      expect(toolResultImages([half, overHalf, TOOL_IMAGE])).toBeUndefined();
      expect(decode).toHaveBeenCalledTimes(1);
    } finally { decode.mockRestore(); }
  });
  it("parses original cluster results without joined pretty-JSON serialization", () => {
    expect(toolResultImageGroup([JSON.stringify(TOOL_IMAGE), TOOL_IMAGE, `caption\n${JSON.stringify(TOOL_IMAGE)}`]))
      .toEqual({ images: Array.from({ length: 3 }, () => ({ data: TOOL_IMAGE.data, mimeType: TOOL_IMAGE.mimeType })), remainder: "caption" });
    expect(toolResultImageGroup(Array.from({ length: 5 }, () => JSON.stringify(TOOL_IMAGE)))).toBeUndefined();
  });
  it("validates GIF, JPEG and all WebP dimension headers without decoding", () => {
    const gif = "GIF89a\x04\0\x04\0";
    const jpeg = "\xff\xd8\xff\xc0\0\x0b\x08\0\x04\0\x04\x01\x01\x11\0";
    const webp = "RIFF\0\0\0\0WEBP";
    expect(safeToolImageDimensions(gif, "image/gif")).toBe(true);
    expect(safeToolImageDimensions(jpeg, "image/jpeg")).toBe(true);
    expect(safeToolImageDimensions(webp + "VP8X\0\0\0\0\0\0\0\0\x03\0\0\x03\0\0", "image/webp")).toBe(true);
    expect(safeToolImageDimensions(webp + "VP8 \0\0\0\0\0\0\0\x9d\x01\x2a\x04\0\x04\0", "image/webp")).toBe(true);
    expect(safeToolImageDimensions(webp + "VP8L\0\0\0\0\x2f\x03\xc0\0\0", "image/webp")).toBe(true);
    expect(safeToolImageDimensions(webp + "VP8L", "image/webp")).toBe(false);
    expect(safeToolImageDimensions(jpeg.slice(0, 5), "image/jpeg")).toBe(false);
  });
  it("leaves ordinary prose and arbitrary JSON untouched; uses a bounded filename label", () => {
    for (const result of ["hello", { answer: 42 }, { unrelated: TOOL_IMAGE }, "https://example.invalid/a.png"]) {
      expect(toolResultImages(result)).toBeUndefined();
    }
    expect(toolImageName({ file_path: "pictures/synthetic.png" })).toBe("synthetic.png");
    expect(toolImageName({ path: "C:\\pictures\\synthetic.jpg" })).toBe("synthetic.jpg");
    expect(toolImageName({})).toBe("Tool result image");
  });
});
