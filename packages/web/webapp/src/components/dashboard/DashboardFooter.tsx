import { useConsoleStore } from "../../console-store";
import { DataModeIndicator } from "../DataModeIndicator";
import { Icon } from "../Icon";

/**
 * One row: what this session has cost on the left, the archive shelf on the
 * right. Both are console-wide switches rather than navigation, so neither one
 * dismisses the mobile drawer.
 */
export function DashboardFooter() {
  const { threads, selectedAgentId, showArchived, setShowArchived } = useConsoleStore();
  const archivedCount = threads.filter(
    (thread) => thread.sourceId === selectedAgentId && Boolean(thread.archivedAt),
  ).length;

  return (
    <div className="dashboard-footer">
      {/* The one place the operator can see what this session has cost and
          change what it is allowed to spend. */}
      <DataModeIndicator />
      <button
        type="button"
        className={`archive-toggle${showArchived ? " is-active" : ""}`}
        onClick={() => setShowArchived(!showArchived)}
      >
        <Icon name={showArchived ? "threads" : "archive"} size={16} />
        <span>{showArchived ? "Back to conversations" : "Archived"}</span>
        {archivedCount > 0 && !showArchived && (
          <span className="archive-count">{archivedCount}</span>
        )}
      </button>
    </div>
  );
}
