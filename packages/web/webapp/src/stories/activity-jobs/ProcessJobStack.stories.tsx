import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { ProcessJobStack } from "../../components/ProcessJobStack";
import { ProcessJobPresentationProvider } from "../../process-job-presentation";
import * as J from "../job-fixtures";

const stack = (jobs: readonly J.Job[], bounded = false) => (
  <div style={{ maxWidth: 860, margin: "0 auto" }}>
    <ProcessJobPresentationProvider threadId="example" messages={[]} jobs={jobs.map(J.entry)} historyIsBounded={bounded}>
      <ProcessJobStack />
    </ProcessJobPresentationProvider>
  </div>
);

type Play = NonNullable<StoryObj<typeof ProcessJobStack>["play"]>;
const click = async (canvasElement: HTMLElement, selector: string) => {
  const target = canvasElement.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`Missing ${selector}`);
  await userEvent.click(target);
};
/** Open the shelf, then optionally History and one row by its job id. */
const open = (options: { readonly history?: boolean; readonly row?: string } = {}): Play => async ({ canvasElement }) => {
  await click(canvasElement, ".process-job-stack-toggle");
  if (options.history) await click(canvasElement, ".process-job-stack-history-toggle");
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
  parameters: { docs: { description: { component: "The conversation's background jobs as a compact shelf above the composer: a closed glance bar, an open list of purpose-first rows, and a detail view per row. Fictional content only." } } },
} satisfies Meta<typeof ProcessJobStack>;
type Story = StoryObj<typeof ProcessJobStack>;

// Glance: the closed bar.
export const Glance: Story = { render: () => stack(J.busyThread) };
export const GlanceSingle: Story = { render: () => stack(J.singleThread) };
export const GlanceSingleAgent: Story = { render: () => stack([J.succeeded, J.subagentRunning]) };
export const GlanceFailedPeerWithQuestion: Story = { render: () => stack([J.succeeded, J.peerFailedPending]) };
export const GlanceCancelledPeerWithQuestion: Story = { render: () => stack([J.succeeded, J.peerCancelledPending]) };
export const GlanceIdle: Story = { render: () => stack(J.idleThread) };
export const GlanceIdleWithIssue: Story = { render: () => stack(J.idleWithIssueThread) };
export const GlanceQuestionOnly: Story = { render: () => stack(J.questionOnlyThread) };
export const GlanceAgentsAndCommands: Story = { render: () => stack(J.agentsAndCommandsThread) };
export const GlanceMany: Story = { render: () => stack(J.manyThread) };
export const GlanceBounded: Story = { render: () => stack([J.succeeded, J.failed], true) };

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
export const Bounded: Story = { render: () => stack([J.runningSilent, J.succeeded], true), play: open({ history: true }) };
export const Stopping: Story = { render: () => stack([J.stopping, J.runningTail]), play: open() };

// Detail: one open row.
export const OpenRow: Story = { render: () => stack(J.busyThread), play: open({ row: J.runningTail.summary }) };
export const FailedRow: Story = { render: () => stack([J.failed, J.timedOut]), play: open({ history: true, row: J.failed.summary }) };
export const SubagentRunning: Story = { render: () => stack([J.subagentRunning]), play: open({ row: J.subagentRunning.summary }) };
export const SubagentFinished: Story = { render: () => stack([J.subagentDone]), play: open({ history: true, row: J.subagentDone.summary }) };
export const SubagentQuestion: Story = { render: () => stack([J.subagentAsked]), play: open({ history: true, row: J.subagentAsked.summary }) };
export const PeerQuestion: Story = { render: () => stack([J.peerPending]), play: open({ row: J.peerPending.summary }) };
export const LongContent: Story = { render: () => stack([J.longSummary]), play: open({ row: J.longSummary.summary }) };

// Viewports and palettes (the viewport global only applies in the Storybook manager).
export const Phone: Story = { render: () => stack(J.busyThread), play: open(), globals: { viewport: { value: "phone" } } };
export const PhoneGlance: Story = { render: () => stack(J.busyThread), globals: { viewport: { value: "phone" } } };
export const Dark: Story = { render: () => stack(J.busyThread), play: open(), globals: { scheme: "dark" } };
export const TerracottaDark: Story = { render: () => stack(J.allStatesThread), play: open({ history: true }), globals: { scheme: "dark", theme: "terracotta" } };
