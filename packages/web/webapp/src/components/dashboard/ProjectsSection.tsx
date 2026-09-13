import { useConsoleStore } from "../../console-store";
import type { ProjectSummary } from "../../types";
import { Icon } from "../Icon";
import { relativeTime } from "../time";

const chatCountLabel = (count: number): string =>
  `${String(count)} chat${count === 1 ? "" : "s"}`;

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
          <Icon name="new" size={12} />
          New
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
        {/* The Running card's agent tile, holding a folder: a project row and
            a card sit on the same x, and the tile says what the row IS. */}
        <span className="project-tile" data-project-color={project.color ?? "default"} aria-hidden="true">
          <Icon name="folder" size={15} />
        </span>
        <span className="project-copy">
          <span className="project-title">{project.name}</span>
          <span className="project-preview">
            <span className="project-preview-text">
              {chatCountLabel(project.conversationCount)} · updated{" "}
              <time dateTime={project.updatedAt}>{relativeTime(project.updatedAt)}</time>
            </span>
          </span>
        </span>
        {project.runningCount > 0 && (
          <span className="project-status">
            {String(project.runningCount)} running
          </span>
        )}
        <span className="project-chevron" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>
    </div>
  );
}
