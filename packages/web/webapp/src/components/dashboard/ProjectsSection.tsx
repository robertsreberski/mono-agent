import { useState } from "react";
import { useConsoleStore } from "../../console-store";
import { readProjectsCollapsed, writeProjectsCollapsed } from "../../projects-collapsed";
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
 *
 * The label row collapses the listing, and the choice outlives the tab in this
 * browser. The heading keeps its `h2` semantics with the toggle inside it, so
 * the section stays labelled while the button carries the expanded state, and
 * the New action sits beside the toggle rather than inside it so creating a
 * project never collapses the section.
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
  // Resolved in the initializer so the first paint already matches the stored
  // choice; an effect would flash the rows open before hiding them.
  const [collapsed, setCollapsed] = useState<boolean>(readProjectsCollapsed);

  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeProjectsCollapsed(next);
  };

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-projects-label">
      <div className="dashboard-section-head">
        <h2 className="dashboard-section-label" id="dashboard-projects-label">
          <button
            type="button"
            className="dashboard-section-toggle"
            aria-expanded={!collapsed}
            aria-controls="dashboard-projects-list"
            onClick={toggleCollapsed}
          >
            <span className="dashboard-section-chevron" aria-hidden="true">
              <Icon name="chevron" size={12} />
            </span>
            Projects
            {collapsed && (
              <span className="dashboard-section-count">{projects.length}</span>
            )}
          </button>
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
      <div
        id="dashboard-projects-list"
        role="region"
        aria-labelledby="dashboard-projects-label"
        hidden={collapsed}
      >
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} onOpen={() => openProjectById(project.id)} />
        ))}
      </div>
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
