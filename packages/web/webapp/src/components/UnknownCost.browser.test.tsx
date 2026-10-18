import { fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { agent, project, thread } from "../test/fixtures";
import { RunningSection } from "./dashboard/RunningSection";
import { ProjectPage } from "./project/ProjectPage";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import { SubagentPart } from "./Subagent";
import "../styles.css";

vi.mock("../console-store", () => ({ useConsoleStore: () => ({
  agents: [], closeProject: () => undefined, createThread: async () => undefined, creatingThread: false,
  hasMoreProjectMembers: false, loadMoreProjectMembers: async () => undefined, openProjectById: () => undefined,
  projectMembers: [], projectMembersError: null, projectMembersLoading: false, selectionError: null,
  selectionLoading: false, unreadThreadIds: new Set<string>(),
}) }));
vi.mock("./dashboard/DashboardFooter", () => ({ DashboardFooter: () => null }));
vi.mock("@assistant-ui/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@assistant-ui/react")>(),
  ThreadListPrimitive: { Root: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>, Items: () => null },
}));

it.each([[390, 844], [1440, 1000]])("renders synthetic dashboard and month unknown costs at %i x %i", async (width, height) => {
  await page.viewport(width, height);
  const source = agent("synthetic", { label: "Synthetic agent" });
  const active = thread("synthetic-run", "synthetic", { title: "Synthetic unknown run", runState: {
    status: "running", activity: { toolCallCount: 1, phase: "working", cumulativeUsd: null, knownCostUsd: 3 },
  } });
  render(<main style={{ width: "100%", maxWidth: 800, margin: "auto", padding: 16 }}><h1>Synthetic unknown-cost states</h1>
    <RunningSection groups={[{ agent: source, threads: [active] }]} expandedAgentIds={new Set<string>()}
      onToggleAgent={() => undefined} onOpen={() => undefined} />
    <ProjectPage project={project("synthetic-project", "synthetic", { name: "Synthetic project", monthUsd: null, monthKnownUsd: 3 })} />
  </main>);
  expect(screen.getByText(/Working.*cost unknown/)).toBeVisible();
  expect(screen.getByText("Known cost $3.00")).toBeVisible();
  expect(screen.getByText(/cost unknown this month/)).toBeVisible();
  expect(screen.getByText("Known cost $3.00 this month")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const shots = import.meta.env.VITE_UNKNOWN_COST_SHOTS;
  if (typeof shots === "string") await page.screenshot({ path: `${shots}/synthetic-unknown-running-and-project-${width}x${height}.png` });
});

it.each([[390, 844], [1440, 1000]])("renders a synthetic priced parent and unknown child at %i x %i", async (width, height) => {
  await page.viewport(width, height);
  render(<main style={{ width: "100%", maxWidth: 800, margin: "auto", padding: 16 }}>
    <h1>Synthetic priced parent, unknown child</h1>
    <ContextDisplay context={{ status: "unavailable" }} totals={{ total: { costUsd: null, knownCostUsd: 3 },
      subagents: { runs: 1, costUsd: null }, byModel: [], computedAt: "2026-01-01T00:00:00Z" }} />
    <SubagentPart type="data" name="subagent" status={{ type: "complete" }} data={{ type: "subagent", name: "Synthetic helper",
      status: "complete", costUsd: null, calls: [], result: "Synthetic reply" }} />
  </main>);
  expect(screen.getByText(/cost unknown/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Context usage:/ }));
  expect(await screen.findByText("Known cost")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const shots = import.meta.env.VITE_UNKNOWN_COST_SHOTS;
  if (typeof shots === "string") await page.screenshot({ path: `${shots}/synthetic-priced-parent-unknown-child-${width}x${height}.png` });
});
