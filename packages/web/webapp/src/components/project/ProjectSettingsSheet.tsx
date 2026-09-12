import type { ProjectColor } from "../../types";
import { type RefObject, useEffect, useState } from "react";
import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";

export type ProjectSettingsState =
  /** `threadId`: the conversation the new project is made from; it becomes the first member. */
  | { readonly mode: "create"; readonly sourceId?: string; readonly threadId?: string }
  | { readonly mode: "edit"; readonly projectId: string };

const MAX_NAME_CHARACTERS = 120;
const MAX_CONTEXT_CHARACTERS = 4000;

/** Short month names, so the created line reads `d MMM` in every locale. */
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const createdLabel = (createdAt: string): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return `${String(date.getUTCDate())} ${SHORT_MONTHS[date.getUTCMonth()]}`;
};

/**
 * Create a project or edit its name, context, archive state and deletion.
 *
 * Opened over whichever screen is showing through the
 * `mono-agent:project-settings` event, like the agent settings dialog: closing
 * leaves the operator where they were. Mobile draws a bottom sheet, desktop a
 * centered dialog; the difference is viewport CSS, not structure.
 */
export function ProjectSettingsSheet({
  sheet,
  onClose,
  dialogRef,
}: {
  readonly sheet: ProjectSettingsState | null;
  readonly onClose: () => void;
  readonly dialogRef: RefObject<HTMLElement | null>;
}) {
  const store = useConsoleStore();
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [color, setColor] = useState<ProjectColor>("default");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = sheet?.mode === "edit"
    ? Object.values(store.projectsByAgent)
      .flatMap((list) => list)
      .find((item) => item.id === sheet.projectId) ?? null
    : null;
  const agentLabel = (sheet?.mode === "create" && sheet.sourceId !== undefined
    ? store.agents.find((agent) => agent.sourceId === sheet.sourceId)
    : store.selectedAgent
  )?.label ?? store.selectedAgent?.label ?? "agent";
  const sheetKey = sheet === null
    ? null
    : sheet.mode === "edit" ? sheet.projectId : `create:${sheet.sourceId ?? ""}`;

  useEffect(() => {
    if (sheetKey === null) return;
    setName(project?.name ?? "");
    setContext(project?.context ?? "");
    setColor(project?.color ?? "default");
    setError(null);
    setSaving(false);
    // Reset per opened sheet, never per store update: a project event landing
    // while the operator is typing must not clobber the draft.
  }, [sheetKey]);

  if (sheet === null) return null;
  const editing = sheet.mode === "edit";
  const nameValid = name.trim().length > 0;
  const changed = !editing
    || (project !== null
      && (name.trim() !== project.name || context !== project.context || color !== (project.color ?? "default")));
  const inactive = saving || !nameValid || (editing && !changed);

  const save = async (): Promise<void> => {
    if (inactive) return;
    setSaving(true);
    setError(null);
    try {
      if (!editing) {
        const created = await store.createProject(
          name.trim(),
          context,
          sheet.sourceId,
          color,
        );
        if (sheet.threadId !== undefined) await store.setThreadProject(sheet.threadId, created.id);
        store.openProjectById(created.id);
      } else if (project !== null) {
        await store.patchProject(project.id, {
          ...(name.trim() !== project.name ? { name: name.trim() } : {}),
          ...(context !== project.context ? { context } : {}),
          ...(color !== (project.color ?? "default") ? { color } : {}),
        });
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (): Promise<void> => {
    if (project === null) return;
    const confirmed = window.confirm(
      "Archive this project? Its conversations stay, keep their context, and leave the Projects list.",
    );
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await store.archiveProject(project.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (project === null) return;
    const confirmed = window.confirm(
      "Delete this project? Its conversations move back to the agent. This cannot be undone.",
    );
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await store.deleteProject(project.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="sheet project-settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <button type="button" className="sheet-cancel" onClick={onClose}>
            Cancel
          </button>
          <h2 id="project-settings-title">
            {editing ? "Project settings" : "New project"}
          </h2>
          <button
            type="button"
            className="sheet-save"
            disabled={inactive}
            onClick={() => { void save(); }}
          >
            Save
          </button>
        </header>
        {editing && project === null ? (
          <p className="sheet-error" role="alert">This project is no longer available.</p>
        ) : (
          <>
            <label className="sheet-field">
              <span className="dashboard-section-label">Name</span>
              <input
                value={name}
                maxLength={MAX_NAME_CHARACTERS}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                aria-label="Project name"
                disabled={saving}
              />
            </label>
            <fieldset className="project-palette" disabled={saving}>
              <legend>Color</legend>
              {(["default", "blue", "purple", "amber", "rose"] as const).map((choice) => (
                <button type="button" key={choice} data-project-color={choice} aria-label={`${choice} project color`}
                  aria-pressed={color === choice} onClick={() => setColor(choice)}>{choice}</button>
              ))}
            </fieldset>
            <label className="sheet-field">
              <span className="dashboard-section-label sheet-field-head">
                Context
                <span className="sheet-char-count">{`${String(context.length)} chars`}</span>
              </span>
              <textarea
                value={context}
                maxLength={MAX_CONTEXT_CHARACTERS}
                onChange={(event) => setContext(event.target.value)}
                placeholder="Shared briefing for every conversation in this project"
                aria-label="Project context"
                rows={5}
                disabled={saving}
              />
              <span className="sheet-footnote">
                Prepended to every conversation in this project. Existing conversations pick it up on their next turn.
              </span>
            </label>
            {error !== null && <p className="sheet-error" role="alert">{error}</p>}
            {editing && project !== null && (
              <>
                <div className="sheet-group" role="group" aria-label="Danger zone">
                  <button type="button" className="sheet-row" onClick={() => { void archive(); }} disabled={saving}>
                    <Icon name="archive" size={16} />
                    <span className="sheet-row-label">Archive project</span>
                    <span className="sheet-row-hint">Keeps chats</span>
                  </button>
                  <button
                    type="button"
                    className="sheet-row is-danger"
                    onClick={() => { void remove(); }}
                    disabled={saving}
                  >
                    <Icon name="trash" size={16} />
                    <span className="sheet-row-label">Delete project</span>
                    <span className="sheet-row-hint">Chats move to agent</span>
                  </button>
                </div>
                <p className="sheet-created">
                  {`Created ${createdLabel(project.createdAt)} · ${agentLabel}`}
                </p>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
