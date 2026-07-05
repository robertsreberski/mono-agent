import type { MemoryBlock } from "@mono-agent/agent-contracts";
import type { MemoryDb } from "../store/index.js";

import { MARKER_FOR } from "./grammar.js";

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number } = {},
): Promise<MemoryBlock | undefined> {
  const maxBytes = options.maxBytes ?? 8_000;
  const hits = await db.recall(query, { topK: options.topK ?? 8 });
  // No hits → no block. A header-only block carries no signal and only adds
  // noise/tokens to whatever surface injects it; returning undefined lets
  // callers skip injection via their existing `block === undefined` guard.
  if (hits.length === 0) {
    return undefined;
  }
  const lines = ["## Memory (recalled)", ""];
  for (const hit of hits) {
    const star = hit.record.isInsight ? " *" : "";
    // Marker reflects type *and* status (e.g. a done task renders `- [x]`, not `- [ ]`); recall
    // surfaces done/scheduled/migrated records, so a type-only marker would misrepresent their state.
    lines.push(`- ${MARKER_FOR(hit.record.type, hit.record.status)} ${hit.record.text}${star}`);
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = clampToBytes(content, maxBytes);
    truncated = true;
  }
  return { kind: "markdown", content, source: "memory-bujo", truncated };
}

function clampToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // Cut on a UTF-8 boundary by decoding a sliced buffer leniently.
  return new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes)).replace(/�+$/u, "");
}
