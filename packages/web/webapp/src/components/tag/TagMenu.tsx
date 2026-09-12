import { Menu } from "@base-ui/react/menu";
import { useConsoleStore } from "../../console-store";
import type { ThreadSummary } from "../../types";
import { Icon } from "../Icon";
import { TagChip } from "./TagChip";
import type { TagSettingsState } from "./TagSettingsSheet";

export function TagMenu({ thread }: { readonly thread: ThreadSummary }) {
  const { tagsByAgent, loadTags, setThreadTags } = useConsoleStore();
  const tags = tagsByAgent?.[thread.sourceId] ?? [];
  const ids = thread.tagIds ?? [];
  const openSettings = (detail: TagSettingsState) => window.dispatchEvent(new CustomEvent("mono-agent:tag-settings", { detail }));
  return (
    <Menu.Root onOpenChange={(open) => { if (open) void loadTags(thread.sourceId).catch(() => undefined); }}>
      <Menu.Trigger type="button" className="conversation-tags-trigger" aria-label="Conversation tags" title="Conversation tags">
        <Icon name="tag" size={14} />
        {ids.length === 0 && <span>Add tag</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="conversation-menu-positioner" side="bottom" align="start" sideOffset={5}>
          <Menu.Popup className="conversation-menu-popup tag-menu-popup" aria-label="Conversation tags">
            {tags.length === 0 && <div className="conversation-menu-empty">No tags yet</div>}
            {tags.map((tag) => (
              <Menu.Item key={tag.id} className="conversation-menu-item" aria-label={`${ids.includes(tag.id) ? "Remove" : "Add"} ${tag.name}`}
                onClick={() => { void setThreadTags(thread.id, ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]).catch(() => undefined); }}>
                <TagChip tag={tag} />
                {ids.includes(tag.id) && <Icon name="check" size={14} />}
              </Menu.Item>
            ))}
            <Menu.Separator className="tag-menu-separator" />
            <Menu.Item className="conversation-menu-item"
              onClick={() => openSettings({ mode: "create", sourceId: thread.sourceId, threadId: thread.id })}>
              <Icon name="new" size={16} /><span>New tag…</span>
            </Menu.Item>
            {tags.length > 0 && (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger className="conversation-menu-item">
                  <Icon name="settings" size={16} /><span>Edit tags</span><Icon name="chevron" size={14} />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner className="conversation-menu-positioner" side="bottom" align="start" sideOffset={4}>
                    <Menu.Popup className="conversation-menu-popup tag-menu-popup" aria-label="Edit tags">
                      {tags.map((tag) => <Menu.Item key={tag.id} className="conversation-menu-item" onClick={() => openSettings({ mode: "edit", tagId: tag.id })}><TagChip tag={tag} /></Menu.Item>)}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
