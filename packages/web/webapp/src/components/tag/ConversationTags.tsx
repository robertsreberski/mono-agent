import { useConsoleStore } from "../../console-store";
import { TagChip } from "./TagChip";
import { TagMenu } from "./TagMenu";

export function ConversationTags() {
  const { selectedThread, tagsByAgent } = useConsoleStore();
  if (selectedThread === null) return null;
  const tags = (tagsByAgent?.[selectedThread.sourceId] ?? []).filter((tag) => selectedThread.tagIds?.includes(tag.id));
  return (
    <div className="conversation-tags" aria-label="Conversation tag line">
      {tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
      <TagMenu thread={selectedThread} />
    </div>
  );
}
