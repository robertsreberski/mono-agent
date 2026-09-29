import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { ProcessJobStack } from "../../components/ProcessJobStack";
import { ToolCallRepairProvider } from "../../components/tool-call-repair";
import { ProcessJobPresentationProvider, type ProcessJobParentCall } from "../../process-job-presentation";
import * as J from "../job-fixtures";

// Stories never fetch: the repair offers "Load full message" and reports that nothing was loaded.
const noRepair = async () => false;
const stack = (jobs: readonly J.Job[], bounded = false, parentCalls: readonly ProcessJobParentCall[] = []) => (
  <div style={{ maxWidth: 860, margin: "0 auto" }}>
    <ProcessJobPresentationProvider threadId="example" messages={[]} jobs={jobs.map(J.entry)} parentCalls={parentCalls} historyIsBounded={bounded}>
      <ToolCallRepairProvider repair={noRepair}>
        <ProcessJobStack />
      </ToolCallRepairProvider>
    </ProcessJobPresentationProvider>
  </div>
);
const groups = () => stack(J.groupJobs, false, J.groupParentCalls);

type Play = NonNullable<StoryObj<typeof ProcessJobStack>["play"]>;
const click = async (canvasElement: HTMLElement, selector: string) => {
  const target = canvasElement.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`Missing ${selector}`);
  await userEvent.click(target);
};
/** Open the shelf, then optionally History, one row by its job's summary, one agent group by its id and one parent call by its text. */
const open = (options: { readonly history?: boolean; readonly row?: string; readonly group?: string; readonly call?: string } = {}): Play => async ({ canvasElement }) => {
  await click(canvasElement, ".process-job-stack-toggle");
  if (options.history) await click(canvasElement, ".process-job-stack-history-toggle");
  if (options.group !== undefined) {
    const group = [...canvasElement.querySelectorAll<HTMLElement>(".process-job-group")]
      .find((node) => node.querySelector(".process-job-group-name")?.textContent === options.group);
    const summary = group?.querySelector<HTMLElement>(":scope > summary");
    if (!summary) throw new Error(`Missing group ${options.group}`);
    await userEvent.click(summary);
  }
  if (options.call !== undefined) {
    const head = [...canvasElement.querySelectorAll<HTMLElement>("button.process-job-call-head")]
      .find((node) => node.textContent?.includes(options.call!));
    if (!head) throw new Error(`Missing call ${options.call}`);
    await userEvent.click(head);
  }
  if (options.row !== undefined) {
    const row = [...canvasElement.querySelectorAll<HTMLElement>(".process-job-card")]
      .find((card) => card.querySelector(".process-job-title")?.getAttribute("title") === options.row);
    const summary = row?.querySelector<HTMLElement>("summary");
    if (!summary) throw new Error(`Missing row ${options.row}`);
    await userEvent.click(summary);
  }
};

export default {
  title: "Activity & Jobs/ProcessJobStack",
  component: ProcessJobStack,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "The conversation's background jobs as a compact shelf above the composer: a closed glance bar without a visible title, an open list of purpose-first rows where every detached child (a subagent instance or a peer) is one agent group, and a detail view per row. Fictional content only." } } },
} satisfies Meta<typeof ProcessJobStack>;
type Story = StoryObj<typeof ProcessJobStack>;

// Glance: the closed bar. No visible title; its accessible name starts with "Background jobs".
export const Glance: Story = { render: () => stack(J.busyThread) };
export const GlanceSingle: Story = { render: () => stack(J.singleThread) };
export const GlanceSingleAgent: Story = { render: () => stack([J.succeeded, J.subagentRunning]) };
export const GlanceSingleGroup: Story = { render: () => stack([J.researcherBrief, J.succeeded, J.researcherCompare, J.researcherWindows], false, J.groupParentCalls) };
export const GlanceFailedPeerWithQuestion: Story = { render: () => stack([J.succeeded, J.peerFailedPending]) };
export const GlanceCancelledPeerWithQuestion: Story = { render: () => stack([J.succeeded, J.peerCancelledPending]) };
export const GlanceIdle: Story = { render: () => stack(J.idleThread) };
export const GlanceIdleWithIssue: Story = { render: () => stack(J.idleWithIssueThread) };
export const GlanceQuestionOnly: Story = { render: () => stack(J.questionOnlyThread) };
export const GlanceAgentsAndCommands: Story = { render: () => stack(J.agentsAndCommandsThread) };
export const GlanceMany: Story = { render: () => stack(J.manyThread) };
export const GlanceGroups: Story = { render: groups };
// Active but nothing in progress: the count holds still instead of spinning.
export const GlanceQueued: Story = { render: () => stack([J.succeeded, J.queued, J.activeJob("job-queued-2", "queued", "Purpose: Resize the seed-packet photos", 12, { tool: "Bash" })]) };
export const GlanceBounded: Story = { render: () => stack([J.succeeded, J.failed], true) };
export const GlanceDark: Story = { render: () => stack(J.busyThread), globals: { scheme: "dark" } };
export const GlanceIdleDark: Story = { render: () => stack(J.idleThread), globals: { scheme: "dark" } };
export const GlancePhone: Story = { render: () => stack(J.busyThread), globals: { viewport: { value: "phone" } } };
export const GlanceSinglePhone: Story = { render: () => stack(J.singleThread), globals: { viewport: { value: "phone" } } };

// Inspect: the open shelf.
export const Inspect: Story = { render: () => stack(J.busyThread), play: open() };
export const InspectWithHistory: Story = { render: () => stack(J.busyThread), play: open({ history: true }) };
export const AgentsAndCommands: Story = { render: () => stack(J.agentsAndCommandsThread), play: open() };
export const IssuesAndQuestions: Story = {
  render: () => stack([J.runningTail, J.peerPending, J.peerFailedPending, J.failed, J.timedOut, J.cancelledWake, J.wakeFailed, J.childBusy, J.peerAnswered, J.subagentAsked]),
  play: open({ history: true }),
};
export const AllStates: Story = { render: () => stack(J.allStatesThread), play: open({ history: true }) };
export const Many: Story = { render: () => stack(J.manyThread), play: open() };
export const NothingActive: Story = { render: () => stack(J.idleThread), play: open() };
export const FinishedHistory: Story = { render: () => stack(J.finishedThread), play: open({ history: true }) };
export const Bounded: Story = { render: () => stack([J.runningSilent, J.succeeded], true), play: open({ history: true }) };
export const Stopping: Story = { render: () => stack([J.stopping, J.runningTail]), play: open() };

// Agent groups: every detached child is one row; its timeline shows the parent's calls between the child's turns.
export const Groups: Story = { render: groups, play: open({ history: true }) };
export const GroupResearcher: Story = { render: groups, play: open({ group: "researcher-1" }) };
export const GroupFailedThenRunning: Story = { render: groups, play: open({ group: "seed-planner" }) };
export const GroupStoppedAndClosed: Story = { render: groups, play: open({ history: true, group: "soil-analyst" }) };
export const GroupSingleTurn: Story = { render: groups, play: open({ group: "compost-steward" }) };
export const GroupPeerQuestion: Story = { render: groups, play: open({ group: "seed-bank" }) };
export const GroupLongMessage: Story = { render: groups, play: open({ group: "researcher-1", call: "Find the average last-frost" }) };
export const GroupTruncatedMessage: Story = { render: groups, play: open({ group: "seed-planner", call: "Plan the spring seed order" }) };
export const GroupTurnOpen: Story = { render: groups, play: open({ group: "researcher-1", row: J.researcherWindows.summary }) };
export const GroupFailedTurnOpen: Story = { render: groups, play: open({ group: "seed-planner", row: J.plannerPriced.summary }) };
export const GroupManyTurns: Story = { render: () => stack([...J.longLivedJobs, J.succeeded], false, J.longLivedParentCalls), play: open({ group: "compost-keeper" }) };
export const GroupResearcherPhone: Story = { render: groups, play: open({ group: "researcher-1" }), globals: { viewport: { value: "phone" } } };
export const GroupResearcherDark: Story = { render: groups, play: open({ group: "researcher-1" }), globals: { scheme: "dark" } };

// Detail: one open row.
export const OpenRow: Story = { render: () => stack(J.busyThread), play: open({ row: J.runningTail.summary }) };
export const FailedRow: Story = { render: () => stack([J.failed, J.timedOut]), play: open({ history: true, row: J.failed.summary }) };
export const SubagentRunning: Story = { render: () => stack([J.subagentRunning]), play: open({ group: "garden-helper", row: J.subagentRunning.summary }) };
export const SubagentFinished: Story = { render: () => stack([J.subagentDone]), play: open({ history: true, group: "bed-planner", row: J.subagentDone.summary }) };
export const SubagentQuestion: Story = { render: () => stack([J.subagentAsked]), play: open({ history: true, group: "greenhouse", row: J.subagentAsked.summary }) };
export const PeerQuestion: Story = { render: () => stack([J.peerPending]), play: open({ group: "seed-bank", row: J.peerPending.summary }) };
export const LongContent: Story = { render: () => stack([J.longSummary]), play: open({ row: J.longSummary.summary }) };

// Viewports and palettes (the viewport global only applies in the Storybook manager).
export const Phone: Story = { render: () => stack(J.busyThread), play: open(), globals: { viewport: { value: "phone" } } };
export const PhoneGlance: Story = { render: () => stack(J.busyThread), globals: { viewport: { value: "phone" } } };
export const Dark: Story = { render: () => stack(J.busyThread), play: open(), globals: { scheme: "dark" } };
export const TerracottaDark: Story = { render: () => stack(J.allStatesThread), play: open({ history: true }), globals: { scheme: "dark", theme: "terracotta" } };
