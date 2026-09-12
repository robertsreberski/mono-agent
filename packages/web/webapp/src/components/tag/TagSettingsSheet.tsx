import { type RefObject, useEffect, useRef, useState } from "react";
import { useConsoleStore } from "../../console-store";
import type { TagColor } from "../../types";
import { Icon } from "../Icon";

const COLORS = ["default", "blue", "purple", "amber", "rose", "green", "teal", "red"] as const satisfies readonly TagColor[];
export type TagSettingsState =
  | { readonly mode: "create"; readonly sourceId: string; readonly threadId?: string }
  | { readonly mode: "edit"; readonly tagId: string };

export function TagSettingsSheet({ sheet, onClose, dialogRef }: {
  readonly sheet: TagSettingsState | null;
  readonly onClose: () => void;
  readonly dialogRef: RefObject<HTMLElement | null>;
}) {
  const store = useConsoleStore();
  const latestStore = useRef(store);
  latestStore.current = store;
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("default");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdId = useRef<string | null>(null);
  const tag = sheet?.mode === "edit" ? Object.values(store.tagsByAgent ?? {}).flat().find((item) => item.id === sheet.tagId) : undefined;
  const key = sheet === null ? null : sheet.mode === "edit" ? sheet.tagId : `create:${sheet.sourceId}:${sheet.threadId ?? ""}`;
  useEffect(() => {
    setName(tag?.name ?? ""); setColor(tag?.color ?? "default"); setError(null); setSaving(false); createdId.current = null;
    // Events must not overwrite the operator's draft in an already open sheet.
  }, [key]);
  if (sheet === null) return null;
  const editing = sheet.mode === "edit";
  const valid = name.trim().length > 0 && name.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(name);
  const inactive = saving || !valid || (editing && (tag === undefined || (tag.name === name.trim() && tag.color === color)));
  const save = async () => {
    if (inactive) return;
    setSaving(true); setError(null);
    try {
      if (sheet.mode === "create") {
        // A successful create followed by a failed assignment must be retryable
        // without creating a duplicate tag or discarding the original failure.
        const id = createdId.current ?? (await store.createTag(name.trim(), sheet.sourceId, color)).id;
        createdId.current = id;
        if (sheet.threadId !== undefined) {
          const current = latestStore.current;
          const thread = current.selectedThread?.id === sheet.threadId ? current.selectedThread : current.threads.find((item) => item.id === sheet.threadId);
          if (thread === undefined) throw new Error("The conversation is no longer available.");
          await current.setThreadTags(thread.id, [...new Set([...(thread.tagIds ?? []), id])]);
        }
      } else if (tag !== undefined) await store.patchTag(tag.id, { name: name.trim(), color });
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (tag === undefined || !window.confirm("Delete this tag from all conversations? Conversations are kept. This cannot be undone.")) return;
    setSaving(true); setError(null);
    try { await store.deleteTag(tag.id); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  return (
    <div className="sheet-layer" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="sheet tag-settings-sheet" role="dialog" aria-modal="true" aria-labelledby="tag-settings-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <button type="button" className="sheet-cancel" onClick={onClose}>Cancel</button>
          <h2 id="tag-settings-title">{editing ? "Tag settings" : "New tag"}</h2>
          <button type="button" className="sheet-save" disabled={inactive} onClick={() => { void save(); }}>Save</button>
        </header>
        {editing && tag === undefined ? <p className="sheet-error" role="alert">This tag is no longer available.</p> : <>
          <label className="sheet-field"><span className="dashboard-section-label">Name</span>
            <input aria-label="Tag name" placeholder="Tag name" maxLength={120} value={name} disabled={saving || createdId.current !== null} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="sheet-field"><span className="dashboard-section-label">Color</span>
            <div className="project-palette" role="radiogroup" aria-label="Tag color">
              {COLORS.map((choice) => <button type="button" role="radio" key={choice} data-tag-color={choice} aria-label={`${choice} tag color`} aria-checked={color === choice} disabled={saving || createdId.current !== null} onClick={() => setColor(choice)}>{color === choice && <Icon name="check" size={13} />}</button>)}
            </div>
          </div>
          {editing && <div className="sheet-group"><button type="button" className="sheet-row is-danger" disabled={saving} onClick={() => { void remove(); }}><Icon name="trash" size={16} /><span className="sheet-row-label">Delete tag</span><span className="sheet-row-hint">Keeps chats</span></button></div>}
        </>}
        {error !== null && <p className="sheet-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
