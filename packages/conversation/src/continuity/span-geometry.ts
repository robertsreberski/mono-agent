/** Canonical geometry shared by chronological selection and dispatch validation.
 * Owner paragraphs are indivisible; other paragraphs use overlapping UTF-8 windows. */
export function* ledgerWindows(text: string, owner: boolean): Generator<{ start: number; end: number; text: string }> {
  const bytes = Buffer.from(text); let start = 0;
  for (const paragraph of text.split("\n\n")) {
    const end = start + Buffer.byteLength(paragraph);
    for (let offset = start; offset < end;) {
      let stop = owner ? end : Math.min(end, offset + 8192);
      while (stop < end && (bytes[stop]! & 0xc0) === 0x80) stop--;
      const value = bytes.subarray(offset, stop).toString("utf8");
      if (value.trim()) yield { start: offset, end: stop, text: value };
      if (stop === end) break;
      offset = stop - 256; while ((bytes[offset]! & 0xc0) === 0x80) offset++;
    }
    start = end + 2;
  }
}
