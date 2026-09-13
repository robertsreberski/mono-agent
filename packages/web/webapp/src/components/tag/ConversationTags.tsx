import { useConsoleStore } from "../../console-store";
import { TagChip } from "./TagChip";
import { TagMenu } from "./TagMenu";

export function ConversationTags() {
  const { selectedThread, tagsByAgent } = useConsoleStore();
  if (selectedThread === null) return null;
  const tags = (tagsByAgent?.[selectedThread.sourceId] ?? []).filter((tag) => selectedThread.tagIds?.includes(tag.id));
  return (
    <div className="conversation-tags" aria-label="Conversation tag line">
      <span className="tag-separator" aria-hidden="true">·</span>
      <div className="conversation-tag-chips">
        {tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      </div>
      <TagMenu thread={selectedThread} />
    </div>
  );
}
