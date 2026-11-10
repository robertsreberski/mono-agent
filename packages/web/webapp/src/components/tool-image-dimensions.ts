/** Read raster headers before giving untrusted bytes to the browser decoder. */
export const MAX_TOOL_IMAGE_PIXELS = 16 * 1024 * 1024;
export function safeToolImageDimensions(bytes: string, mime: string): boolean {
  const at = (index: number) => bytes.charCodeAt(index);
  const le16 = (index: number) => at(index) + at(index + 1) * 256;
  const le24 = (index: number) => le16(index) + at(index + 2) * 65536;
  const be16 = (index: number) => at(index) * 256 + at(index + 1);
  const be32 = (index: number) => be16(index) * 65536 + be16(index + 2);
  let width = 0;
  let height = 0;
  if (mime === "image/png" && bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.slice(12, 16) === "IHDR") {
    width = be32(16); height = be32(20);
  } else if (mime === "image/gif" && /^GIF8[79]a/u.test(bytes)) {
    width = le16(6); height = le16(8);
  } else if (mime === "image/jpeg" && at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (at(offset++) !== 0xff) break;
      while (at(offset) === 0xff) offset++;
      const marker = at(offset++);
      if (marker === 0xda || marker === 0xd9) break;
      const length = be16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = be16(offset + 3); width = be16(offset + 5); break;
      }
      offset += length;
    }
  } else if (mime === "image/webp" && bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP") {
    const format = bytes.slice(12, 16);
    if (format === "VP8X" && bytes.length >= 30) {
      width = le24(24) + 1; height = le24(27) + 1;
    } else if (format === "VP8 " && bytes.length >= 30 && bytes.slice(23, 26) === "\x9d\x01\x2a") {
      width = le16(26) & 0x3fff; height = le16(28) & 0x3fff;
    } else if (format === "VP8L" && bytes.length >= 25 && at(20) === 0x2f) {
      width = 1 + ((at(21) | at(22) << 8) & 0x3fff);
      height = 1 + ((at(22) >> 6 | at(23) << 2 | at(24) << 10) & 0x3fff);
    }
  }
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 && width * height <= MAX_TOOL_IMAGE_PIXELS;
}
