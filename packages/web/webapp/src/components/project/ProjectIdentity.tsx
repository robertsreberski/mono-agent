import { useAuiState } from "@assistant-ui/react";
import { useConsoleStore } from "../../console-store";
import type { ProjectTransition } from "../../types";
import { Icon } from "../Icon";

/**
 * A membership change is a quiet rule across the transcript, not a message:
 * a faint tinted line with the event in the middle, between the turn it
 * followed and the first turn that carried the new context.
 */
export function ProjectMarkers({ transitions = [] }: { readonly transitions?: readonly ProjectTransition[] }) {
  return <>{transitions.map((transition) => (
    <div
      key={transition.id}
      className="project-transition"
      role="note"
      data-project-color={(transition.after ?? transition.before)?.color ?? "default"}
      title={new Date(transition.createdAt).toLocaleString()}
    >
      <span className="project-transition-label">
        <Icon name="folder" size={11} />
        <span>{transition.before === null ? `Joined ${transition.after?.name ?? "project"}`
          : transition.after === null ? `Left ${transition.before.name}`
            : `Moved from ${transition.before.name} to ${transition.after.name}`}</span>
      </span>
    </div>
  ))}</>;
}

export function MessageProjectMarkers() {
  const transitions = useAuiState((state) => state.message.metadata.custom?.projectTransitions) as readonly ProjectTransition[] | undefined;
  return <ProjectMarkers transitions={transitions} />;
}

export function StartProjectMarkers() {
  const { detail } = useConsoleStore();
  return <ProjectMarkers transitions={detail?.projectTransitions?.filter((item) => item.afterMessageId === null)} />;
}

/**
 * The conversation's project, as the eyebrow above its title -- the same
 * place the Dashboard keeps the console name above the agent's. It opens the
 * project, and while a membership change waits for the running turn it says
 * so in the same line rather than growing a second badge.
 */
export function ProjectBadge() {
  const { selectedThread, projectsByAgent, openProjectById } = useConsoleStore();
  if (selectedThread === null) return null;
  const projects = projectsByAgent[selectedThread.sourceId] ?? [];
  const project = projects.find((item) => item.id === selectedThread.projectId);
  const pending = selectedThread.pendingProject;
  const destination = pending === undefined || pending.projectId === null ? undefined
    : projects.find((item) => item.id === pending.projectId);
  if (project === undefined && pending === undefined) return null;
  const note = pending === undefined ? null
    : pending.projectId === null ? "leaves after this turn"
      : project === undefined ? `joins ${destination?.name ?? "a project"} after this turn`
        : `moves to ${destination?.name ?? "another project"} after this turn`;
  return <div className="chat-project-identity" data-project-color={(project ?? destination)?.color ?? "default"}>
    {project !== undefined && <button type="button" className="project-badge" onClick={() => openProjectById(project.id)} aria-label={`Open project ${project.name}`}>
      <Icon name="folder" size={11} /><span>{project.name}</span>
    </button>}
    {note !== null && <span className="project-pending" title="Project context changes after the current turn finishes">
      {project !== undefined && <span aria-hidden="true">·</span>}{note}
    </span>}
  </div>;
}
