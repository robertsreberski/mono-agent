const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export function normalizeInlineText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

/** Clamp text to a UTF-8 byte budget without splitting a code point. */
export function clampUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.length <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return UTF8_DECODER.decode(bytes.subarray(0, end));
}
