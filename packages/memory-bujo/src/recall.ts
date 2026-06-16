import type { MemoryBlock } from "@mono-agent/memory-store";
import type { MemoryDb } from "@mono-agent/memory-store";

const MARKER: Record<string, string> = { task: "- [ ]", event: "- ◦", note: "- –" };

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number } = {},
): Promise<MemoryBlock> {
  const maxBytes = options.maxBytes ?? 8_000;
  const hits = await db.recall(query, { topK: options.topK ?? 8 });
  const lines = ["## Memory (recalled)", ""];
  for (const hit of hits) {
    const star = hit.record.isInsight ? " *" : "";
    lines.push(`${MARKER[hit.record.type] ?? "- –"} ${hit.record.text}${star}`);
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
