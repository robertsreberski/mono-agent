interface AudioAttachment { readonly id: string; readonly name: string; readonly contentType?: string | undefined; }
export interface TranscriptPresentation { readonly text: string; readonly captions: ReadonlyMap<string, string>; }
export const isAudioAttachment = (contentType?: string) => ["audio/webm", "audio/mp4", "audio/ogg"].includes(contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "");

/** Presentation only. Accept a complete canonical adapter suffix, or change nothing.
 * No heuristics for prose, filenames, Markdown headers, missing files or numbering.
 * Duplicate filenames are associated in attachment order, once per attachment.
 */
export function presentTranscripts(text: string, attachments: readonly AudioAttachment[]): TranscriptPresentation {
  const unchanged = { text, captions: new Map<string, string>() };
  const headers = [...text.matchAll(/(?:^|\n\n)Audio transcript ([1-9]\d*) (\("(?:[^"\\\n]|\\[^\n])*"\)):\n/gu)];
  if (!headers.length) return unchanged;
  const available = attachments.filter(item => isAudioAttachment(item.contentType));
  const captions = new Map<string, string>();
  let previous = -1;
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    if (header[1] !== String(i + 1)) return unchanged;
    let name: string;
    try { name = JSON.parse(header[2]!.slice(1, -1)) as string; } catch { return unchanged; }
    if (`(${JSON.stringify(name)})` !== header[2]) return unchanged;
    const index = available.findIndex((item, index) => index > previous && item.name === name);
    if (index < 0) return unchanged;
    previous = index;
    const start = header.index! + header[0].length;
    const end = headers[i + 1]?.index ?? text.length;
    const caption = text.slice(start, end);
    if (!caption || caption !== caption.trim() || caption.length > 8000 || /(?:^|\n)Audio transcript /u.test(caption)) return unchanged;
    captions.set(available[index]!.id, caption);
  }
  // Without a schema marker, a subset of duplicate filenames is ambiguous
  // (an uploaded file may have the recorder's name). Preserve the prose rather
  // than guessing which tile owns it.
  for (const attachment of available) {
    const sameName = available.filter(item => item.name === attachment.name);
    const matched = sameName.filter(item => captions.has(item.id));
    if (matched.length && matched.length !== sameName.length) return unchanged;
  }
  const authored = text.slice(0, headers[0]!.index);
  return { text: authored, captions };
}
