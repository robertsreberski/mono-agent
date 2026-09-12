import { ThreadListPrimitive } from "@assistant-ui/react";
import { useMemo } from "react";
import { useConsoleStore } from "../../console-store";
import type { ProjectSummary } from "../../types";
import { formatUsd } from "../../usage";
import { Icon } from "../Icon";
import { DashboardFooter } from "../dashboard/DashboardFooter";
import { ThreadListItem } from "../dashboard/ThreadListItem";
import { flattenCatalogModels } from "../route-label";

const conversationCountLabel = (count: number): string =>
  `${String(count)} conversation${count === 1 ? "" : "s"}`;

/**
 * One project's page, in the Dashboard's own slot.
 *
 * The header walks back to the agent's conversations; the context card names
 * the envelope every member turn carries; the member rows are the shared
 * conversation row, filtered to this project's ids. The footer is the
 * Dashboard's own, without the archive shelf: archiving here is per project,
 * in the settings sheet.
 */
export function ProjectPage({
  project,
  onNavigate,
  highlightSelected = true,
}: {
  readonly project: ProjectSummary;
  readonly onNavigate?: () => void;
  readonly highlightSelected?: boolean;
}) {
  const {
    agents,
    catalogByProvider,
    closeProject,
    createThread,
    creatingThread,
    hasMoreProjectMembers,
    loadMoreProjectMembers,
    openProjectById,
    projectMembers,
    projectMembersError,
    projectMembersLoading,
    selectedAgentId,
    selectionError,
    selectionLoading,
    unreadThreadIds,
  } = useConsoleStore();
  // Every member belongs to the project's agent, so its rows resolve their
  // route badge against that one agent -- and against the loaded catalog only
  // when that agent is the selected one, which is whose catalog it is.
  const projectAgent = agents.find((agent) => agent.sourceId === project.sourceId) ?? null;
  const agentLabel = projectAgent?.label ?? "Conversations";
  const catalogModels = useMemo(
    () => project.sourceId === selectedAgentId ? flattenCatalogModels(catalogByProvider) : undefined,
    [catalogByProvider, project.sourceId, selectedAgentId],
  );
  const memberById = useMemo(
    () => new Map(projectMembers.map((thread) => [thread.id, thread])),
    [projectMembers],
  );
  const meta = [
    conversationCountLabel(project.conversationCount),
    `${String(project.runningCount)} running`,
    ...(project.monthUsd === undefined ? [] : [`${formatUsd(project.monthUsd)} this month`]),
  ].join(" · ");
  const editSettings = (): void => {
    window.dispatchEvent(new CustomEvent("mono-agent:project-settings", {
      detail: { mode: "edit", projectId: project.id },
    }));
  };

  return (
    <div className="project-page" data-project-color={project.color ?? "default"}>
      <header className="project-header">
        <button
          type="button"
          className="project-back"
          aria-label={`Back to ${agentLabel} conversations`}
          title={`Back to ${agentLabel} conversations`}
          onClick={closeProject}
        >
          <Icon name="chevron-left" size={20} />
          <span>{agentLabel}</span>
        </button>
        <div className="dashboard-header-actions">
          <button
            type="button"
            className="agent-settings-button"
            aria-label="Project settings"
            title="Project settings"
            onClick={editSettings}
          >
            <Icon name="settings" size={16} />
          </button>
          <button
            type="button"
            className="new-thread-button"
            aria-label={creatingThread ? "Creating conversation" : "New conversation"}
            aria-busy={creatingThread || undefined}
            title={creatingThread ? "Creating conversation…" : "New conversation (⌘⇧O)"}
            disabled={selectionLoading || selectionError !== null}
            onClick={() => {
              void createThread(project.id).then(() => onNavigate?.()).catch(() => undefined);
            }}
          >
            {creatingThread
              ? <span className="new-thread-spinner" aria-hidden="true" />
              : <Icon name="new" size={17} />}
          </button>
        </div>
      </header>
      <div className="project-scroll">
        <div className="project-title-block">
          <span className="dashboard-section-label">
            <Icon name="folder" size={12} />
            Project
          </span>
          <h1 className="project-name">{project.name}</h1>
          <p className="project-meta">{meta}</p>
        </div>
        <div className="project-context-card">
          <div className="project-context-head">
            <span className="dashboard-section-label">Context</span>
            <button type="button" className="project-context-edit" onClick={editSettings}>
              Edit
            </button>
          </div>
          {project.context.trim().length === 0 ? (
            <p className="project-context-text is-empty">No context yet.</p>
          ) : (
            <p className="project-context-text">{project.context}</p>
          )}
          <p className="project-context-footnote">Prepended to every conversation in this project</p>
        </div>
        <div className="project-members-head">
          <span className="dashboard-section-label">Conversations</span>
          <span className="project-members-sort">Sorted by recent</span>
        </div>
        {projectMembersError !== null && (
          <div className="thread-list-error" role="alert">
            <span>Conversations could not be refreshed. {projectMembersError}</span>
            <button type="button" onClick={() => openProjectById(project.id)}>Retry conversations</button>
          </div>
        )}
        <ThreadListPrimitive.Root className="thread-list">
          <ThreadListPrimitive.Items archived={false}>
            {({ threadListItem }) => {
              const thread = memberById.get(threadListItem.id);
              return thread === undefined ? null : (
                <ThreadListItem
                  thread={thread}
                  agent={projectAgent}
                  catalogModels={catalogModels}
                  unread={unreadThreadIds.has(thread.id)}
                  onNavigate={onNavigate}
                  highlightSelected={highlightSelected}
                />
              );
            }}
          </ThreadListPrimitive.Items>
          {projectMembers.length === 0 && (
            <div className="thread-list-empty">
              <Icon name="threads" size={19} />
              <span>
                {projectMembersError !== null
                  ? "Conversations unavailable"
                  : projectMembersLoading
                    ? "Loading conversations…"
                    : "No conversations yet"}
              </span>
            </div>
          )}
          {hasMoreProjectMembers && (
            <button
              type="button"
              className="thread-load-more"
              onClick={() => { void loadMoreProjectMembers().catch(() => undefined); }}
            >
              Load older conversations
            </button>
          )}
        </ThreadListPrimitive.Root>
      </div>
      <DashboardFooter archiveShelf={false} />
    </div>
  );
}
