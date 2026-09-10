import { useConsoleStore } from "../../console-store";
import { CollectionRow } from "../CollectionRow";

/**
 * The folder-style rows between Running and Recent. Today there is exactly one
 * -- Automations, the agent's cron jobs -- and projects will join it here.
 *
 * Hidden on the archive shelf: an archived listing is a listing of
 * conversations, and the collection is not one of them.
 */
export function CollectionsSection() {
  const { cronOverview, showArchived, setNavigationDestination } = useConsoleStore();
  if (showArchived) return null;
  const jobs = cronOverview?.jobs.length;
  return (
    <section className="dashboard-section dashboard-collections" aria-label="Collections">
      <CollectionRow
        label="Automations"
        icon="clock"
        count={jobs}
        countA11yLabel={jobs === undefined
          ? undefined
          : `${String(jobs)} automation ${jobs === 1 ? "job" : "jobs"}`}
        onSelect={() => setNavigationDestination("automations")}
      />
    </section>
  );
}
