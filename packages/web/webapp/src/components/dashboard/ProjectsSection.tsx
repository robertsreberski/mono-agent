import { useConsoleStore } from "../../console-store";
import type { ProjectSummary } from "../../types";
import { Icon } from "../Icon";

const conversationCountLabel = (count: number): string =>
  `${String(count)} conversation${count === 1 ? "" : "s"}`;

/**
 * The selected agent's projects, between Running and Recent.
 *
 * Rows open the project page; the "+ New" text action opens the settings sheet
 * in create mode. Hidden down to the label row when the agent has no active
 * projects: archived projects stay out of this listing.
 */
export function ProjectsSection() {
  const {
    projectsByAgent,
    selectedAgentId,
    openProjectById,
  } = useConsoleStore();
  const projects = (selectedAgentId === null
    ? []
    : projectsByAgent[selectedAgentId] ?? []
  ).filter((project) => project.archivedAt === null);

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-projects-label">
      <div className="dashboard-section-head">
        <h2 className="dashboard-section-label" id="dashboard-projects-label">
          Projects
        </h2>
        <button
          type="button"
          className="dashboard-new-action"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("mono-agent:project-settings", {
              detail: { mode: "create" },
            }));
          }}
        >
          + New
        </button>
      </div>
      {projects.map((project) => (
        <ProjectRow key={project.id} project={project} onOpen={() => openProjectById(project.id)} />
      ))}
    </section>
  );
}

function ProjectRow({ project, onOpen }: {
  readonly project: ProjectSummary;
  readonly onOpen: () => void;
}) {
  return (
    <div className="project-item">
      <button
        type="button"
        className="project-trigger"
        aria-label={`Open project ${project.name}`}
        onClick={onOpen}
      >
        <span className="project-kind" role="img" aria-label="Project" title="Project">
          <Icon name="folder" size={16} />
        </span>
        <span className="project-copy">
          <span className="project-title-line">
            <span className="project-title">{project.name}</span>
          </span>
          <span className="project-preview">
            {project.runningCount > 0 && (
              <i
                className="thread-running"
                role="img"
                aria-label={`${String(project.runningCount)} running`}
              />
            )}
            <span className="project-preview-text">
              {conversationCountLabel(project.conversationCount)}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}
