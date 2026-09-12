import type { TagSummary } from "../../types";

export function TagChip({ tag }: { readonly tag: Pick<TagSummary, "name" | "color"> }) {
  return <span className="tag-chip" data-tag-color={tag.color} title={tag.name}>{tag.name}</span>;
}
