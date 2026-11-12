import type { ContinuityPreviewRange } from "./continuity-contracts.js";

// Unicode 16 script names (the supported Node runtime's Unicode baseline).
// Resolve query-edge scripts once, never segment/copy whole retained bodies.
const scripts = `Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum
Bassa_Vah Batak Bengali Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid
Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee Chorasmian Common
Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra
Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay Georgian Glagolitic
Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Han Hangul
Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inherited
Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi
Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Kirat_Rai Lao Latin
Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam
Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui
Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar
Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong
Ogham Ol_Chiki Ol_Onal Old_Hungarian Old_Italic Old_North_Arabian Old_Permic
Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya
Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic
Samaritan Saurashtra Sharada Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng
Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham
Tai_Viet Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh Tirhuta
Todhri Toto Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi
Zanabazar_Square`.split(/\s+/u).map(name => ({ name, pattern: new RegExp(`\\p{sc=${name}}`, "u") }));
// These scripts commonly omit spaces. Contiguous script runs remain searchable
// by substrings, not a language-specific dictionary or a claim of word identity.
const unspaced = new Set(["Han", "Hiragana", "Katakana", "Bopomofo", "Thai", "Lao", "Khmer", "Myanmar", "Khitan_Small_Script", "Nushu", "Tangut", "Yi"]);
function edge(character: string | undefined, letter: string | undefined, before: boolean): string | undefined {
  if (!character || !/[\p{L}\p{N}\p{M}_]/u.test(character)) return undefined;
  if (/[\p{M}_]/u.test(character) || (/\p{N}/u.test(character) && !letter)) return "[\\p{L}\\p{N}\\p{M}_]";
  // Digits in an identifier inherit its nearest letter's script; standalone
  // numeric terms must not match inside words or larger numbers of any script.
  const script = scripts.find(({ pattern }) => pattern.test(letter ?? character))?.name;
  // A preceding mark may finish the previous syllable (e.g. Thai); a trailing
  // mark still belongs to the matched grapheme and must not be cut off.
  if (script && unspaced.has(script)) return before ? "[\\p{N}_]" : "[\\p{N}\\p{M}_]";
  // v-mode intersection excludes script-associated punctuation. Numbers, marks
  // and underscores join identifiers across scripts; letters join their script.
  return script ? `[[\\p{L}&&\\p{scx=${script}}]\\p{N}\\p{M}_]` : "[\\p{L}\\p{N}\\p{M}_]";
}
export function expression(value: string, bounded = false, component = false): RegExp {
  const characters = [...value];
  const beforeEdge = bounded ? edge(characters[0], characters.find(character => /\p{L}/u.test(character)), true) : undefined;
  const afterEdge = bounded ? edge(characters.at(-1), characters.slice().reverse().find(character => /\p{L}/u.test(character)), false) : undefined;
  const before = component ? beforeEdge?.replaceAll("_]", "]") : beforeEdge;
  const after = component ? afterEdge?.replaceAll("_]", "]") : afterEdge;
  const literal = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${before ? `(?<!${before})` : ""}${literal}${after ? `(?!${after})` : ""}`, "iv");
}

/** Versioned lexical ranking, not a claim about truth, authority or supersession. */
export function relevanceQuery(query: string) {
  const folded = query.toLowerCase();
  const terms = [...new Set(folded.match(/[\p{L}\p{N}\p{M}_]+(?:[-.:/][\p{L}\p{N}\p{M}_]+)*/gu) ?? [])].slice(0, 16);
  return { folded, terms, patterns: terms.map(term => expression(term, true)), phrase: expression(folded, terms.length > 0), mode: terms.length ? "relevance" as const : "literal" as const };
}
export function relevanceMatch(text: string, query: ReturnType<typeof relevanceQuery>): { score: number; position: number; end: number } | undefined {
  const { expanded, searchable } = matchingText(text);
  const originalPosition = (position: number) => retainedPosition(text, position, expanded);
  const phrase = query.phrase.exec(searchable);
  if (query.mode === "literal") return !phrase ? undefined : { score: 1, position: originalPosition(phrase.index), end: originalPosition(phrase.index + phrase[0].length) };
  // One position per distinct term: repeating a term cannot buy more coverage.
  const matches = query.patterns.map(pattern => pattern.exec(searchable)).filter(match => match !== null);
  if (!matches.length) return undefined;
  const first = matches.reduce((a, b) => a.index <= b.index ? a : b), span = Math.max(...matches.map(match => match.index)) - first.index;
  const selected = phrase ?? first;
  return { score: matches.length * 1_000_000 + (phrase ? 100_000 : 0) + Math.max(0, 65_535 - span), position: originalPosition(selected.index), end: originalPosition(selected.index + selected[0].length) };
}

/** Byte ranges refer to digest-verified sanitized retained text, not raw text.
 * A single excerpt gets up to 512 bytes. Adding a complementary excerpt splits
 * that budget into two windows of up to 256 bytes each, with separate ranges,
 * never a synthetic range spanning omitted bytes. Ranking is unchanged. */
export function matchedPreview(text: string, position: number, matchEnd = position, query?: ReturnType<typeof relevanceQuery>): {
  preview: string; previewRange: ContinuityPreviewRange; additionalPreviews?: readonly { preview: string; previewRange: ContinuityPreviewRange }[];
} {
  const bytes = Buffer.from(text);
  const primary = previewWindow(text, bytes, position, matchEnd, 512);
  if (!query || query.mode === "literal" || primary.previewRange.matchClipped) return primary;
  // Distinct query terms outside the primary window provide complementary
  // referent context, not inferred answers or a semantic qualification claim.
  const { expanded, searchable } = matchingText(text);
  let complementary: { position: number; end: number } | undefined;
  // Only emitted reader items reach here. Query parsing caps the lookup at 16
  // terms; stop at the first complementary match rather than eagerly scanning
  // every term over the full retained body.
  for (const pattern of query.patterns) {
    const match = pattern.exec(searchable);
    if (!match) continue;
    const position = retainedPosition(text, match.index, expanded);
    const matchEnd = retainedPosition(text, match.index + match[0].length, expanded);
    const start = Buffer.byteLength(text.slice(0, position)), end = Buffer.byteLength(text.slice(0, matchEnd));
    if (end <= primary.previewRange.start || start >= primary.previewRange.end) {
      complementary = { position, end: matchEnd }; break;
    }
  }
  if (!complementary) return primary;
  const first = previewWindow(text, bytes, position, matchEnd, 256);
  // Do not sacrifice a long primary phrase merely to add another window.
  if (first.previewRange.matchClipped) return primary;
  const second = previewWindow(text, bytes, complementary.position, complementary.end, 256);
  if (second.previewRange.start < first.previewRange.end && second.previewRange.end > first.previewRange.start) return primary;
  return { ...first, additionalPreviews: [second] };
}
function previewWindow(text: string, bytes: Buffer, position: number, matchEnd: number, budget: number): { preview: string; previewRange: ContinuityPreviewRange } {
  const matchByte = Buffer.byteLength(text.slice(0, position)), endByte = Buffer.byteLength(text.slice(0, matchEnd));
  // Spend the prefix budget on the full match first. Overlong case-folded spans
  // still obey the byte cap and explicitly disclose match clipping.
  let start = Math.max(0, matchByte - Math.min(160, Math.max(0, budget - (endByte - matchByte))));
  while (start < matchByte && continuation(bytes[start])) start++;
  let end = Math.min(bytes.length, start + budget);
  while (end > start && continuation(bytes[end])) end--;
  // Prefer a nearby line/sentence boundary, retaining negation before the hit.
  const lead = bytes.subarray(start, matchByte).toString("utf8");
  const boundary = Math.max(lead.lastIndexOf("\n"), lead.lastIndexOf(". "));
  if (boundary >= 0) start += Buffer.byteLength(lead.slice(0, boundary + 1));
  return { preview: bytes.subarray(start, end).toString("utf8"), previewRange: {
    start, end, clippedBefore: start > 0, clippedAfter: end < bytes.length, complete: false,
    ...(endByte > end ? { matchClipped: true as const } : {}),
  } };
}
// Regex Unicode case folding avoids allocating a second full body. İ is the
// lowercase expansion; both ranking and preview lookup share its retained UTF-16
// offset mapping, then preview windows convert those offsets to retained bytes.
function matchingText(text: string) {
  const expanded = text.includes("İ");
  return { expanded, searchable: expanded ? text.toLowerCase() : text };
}
function retainedPosition(text: string, position: number, expanded: boolean): number {
  if (!expanded) return position;
  let original = 0, folded = 0;
  for (const character of text) { if (folded >= position) break; original += character.length; folded += character.toLowerCase().length; }
  return original;
}
function continuation(byte: number | undefined): boolean { return byte !== undefined && (byte & 0xc0) === 0x80; }
