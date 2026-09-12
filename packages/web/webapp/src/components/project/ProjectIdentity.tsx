import { useAuiState } from "@assistant-ui/react";
import { useConsoleStore } from "../../console-store";
import type { ProjectTransition } from "../../types";
import { Icon } from "../Icon";

export function ProjectMarkers({ transitions = [] }: { readonly transitions?: readonly ProjectTransition[] }) {
  return <>{transitions.map((transition) => (
    <div key={transition.id} className="project-transition" data-project-color={(transition.after ?? transition.before)?.color ?? "default"}>
      <Icon name="folder" size={12} />
      <span>{transition.before === null ? `Joined ${transition.after?.name ?? "project"}`
        : transition.after === null ? `Left ${transition.before.name}`
          : `Moved from ${transition.before.name} to ${transition.after.name}`}</span>
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

export function ProjectBadge() {
  const { selectedThread, projectsByAgent, openProjectById } = useConsoleStore();
  if (selectedThread === null) return null;
  const project = (projectsByAgent[selectedThread.sourceId] ?? []).find((item) => item.id === selectedThread.projectId);
  const pending = selectedThread.pendingProject;
  return <div className="chat-project-identity">
    {project !== undefined && <button type="button" className="project-badge" data-project-color={project.color ?? "default"}
      onClick={() => openProjectById(project.id)} aria-label={`Open project ${project.name}`}>
      <Icon name="folder" size={12} /><span>{project.name}</span>
    </button>}
    {pending !== undefined && <span className="project-pending" title="Project context changes after the current turn finishes">
      {pending.projectId === null ? "Leaving after turn" : "Project changes after turn"}
    </span>}
  </div>;
}
