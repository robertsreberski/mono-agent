import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ThreadListItem } from "../components/dashboard/ThreadListItem";
import { recordEstimatedUsage } from "../data-usage";
import { atlas, gardenThread, researchTag, runningThread } from "./fixtures";
import { storyStore } from "./store";
import { thread } from "../test/fixtures";

export const notesThread = thread("seedling-notes", "atlas", {
  title: "Seedling notes", createdAt: "2026-01-15T10:00:00Z",
  updatedAt: "2026-01-15T11:00:00Z", messageCount: 2,
});
const rows = [gardenThread, runningThread, notesThread];
// The local assistant-ui runtime has no server thread-list adapter, so its
// Items primitive yields no rows. Keep this adapter strictly in Storybook:
// mount actual ThreadListItem components in the real Dashboard's list slot.
// Their AUI Title primitive has no matching remote item; the ref supplies the
// same fictional title as the fixture for display, without changing product code.
export function RecentFixtures() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    Object.assign(storyStore, {
      threads: rows, visibleThreads: rows,
      unreadThreadIds: new Set([notesThread.id]),
      cronOverview: { generatedAt: "2026-01-15T10:00:00Z", actionsEnabled: false, jobs: [{
        jobId: "garden-daily", expression: "0 9 * * *", timezone: "UTC",
        conversationId: "cron:garden-daily", configured: true,
        declaredEnabled: true, effectiveEnabled: true, health: "healthy", threadId: "garden-cron",
      }] },
    });
    recordEstimatedUsage(148 * 1024);
    const list = document.getElementById("dashboard-recent-label")?.closest("section")?.querySelector<HTMLElement>(".thread-list");
    setTarget(list ?? null);
    return () => {
      Object.assign(storyStore, { threads: [gardenThread, runningThread], visibleThreads: [gardenThread, runningThread], unreadThreadIds: new Set(), cronOverview: null });
    };
  }, []);
  if (!target) return null;
  return createPortal(rows.map((item) => <div key={item.id} ref={(node) => {
    const title = node?.querySelector<HTMLElement>(".thread-title");
    if (title) title.textContent = item.title;
  }}><ThreadListItem
    thread={item} agent={atlas} catalogModels={{}} unread={item.id === notesThread.id}
    highlightSelected={false}
    {...(item.projectId === null ? {} : { project: { name: "Garden planner", color: "blue" as const } })}
    tags={item.id === gardenThread.id ? [researchTag] : []}
  /></div>), target);
}
