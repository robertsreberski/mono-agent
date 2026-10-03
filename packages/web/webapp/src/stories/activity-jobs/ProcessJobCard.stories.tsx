import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { ProcessJobCard } from "../../components/ProcessJob";
import * as J from "../job-fixtures";

const part = (job: J.Job) => ({ type: "process-job" as const, job });
const openCard: NonNullable<StoryObj<typeof ProcessJobCard>["play"]> = async ({ canvasElement }) => {
  const summary = canvasElement.querySelector<HTMLElement>(".process-job-card > summary");
  if (summary === null) throw new Error("Missing card summary");
  await userEvent.click(summary);
};

export default {
  title: "Activity & Jobs/ProcessJobCard",
  component: ProcessJobCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="process-job-stack is-open" style={{ maxHeight: "none", padding: 6 }}><Story /></div>],
  argTypes: { part: { control: "object", description: "Persisted, fictional job projection; not a polling live job." } },
} satisfies Meta<typeof ProcessJobCard>;
type Story = StoryObj<typeof ProcessJobCard>;

export const Queued: Story = { args: { part: part(J.queued) } };
export const Starting: Story = { args: { part: part(J.starting) } };
export const Running: Story = { args: { part: part(J.runningTail) } };
export const RunningOpen: Story = { args: { part: part(J.runningTail) }, play: openCard };
export const RunningNoOutput: Story = { args: { part: part(J.runningSilent) }, play: openCard };
export const Stopping: Story = { args: { part: part(J.stopping) } };
export const Succeeded: Story = { args: { part: part(J.succeeded) }, play: openCard };
export const SucceededNoOutput: Story = { args: { part: part(J.redacted) }, play: openCard };
export const Failed: Story = { args: { part: part(J.failed) }, play: openCard };
export const TimedOut: Story = { args: { part: part(J.timedOut) }, play: openCard };
export const Cancelled: Story = { args: { part: part(J.cancelled) } };
export const CancelledWithWakeFailure: Story = { args: { part: part(J.cancelledWake) }, play: openCard };
export const SpawnFailed: Story = { args: { part: part(J.spawnFailed) }, play: openCard };
export const QueueExpired: Story = { args: { part: part(J.queueExpired) } };
export const Interrupted: Story = { args: { part: part(J.interrupted) } };
export const WakeFailed: Story = { args: { part: part(J.wakeFailed) } };
export const LongPurpose: Story = { args: { part: part(J.longSummary) } };
export const LongOutput: Story = { args: { part: part(J.longSummary) }, play: openCard };
export const SubagentRunning: Story = { args: { part: part(J.subagentRunning) }, play: openCard };
export const SubagentFinished: Story = { args: { part: part(J.subagentDone) }, play: openCard };
export const SubagentChildStillBusy: Story = { args: { part: part(J.childBusy) } };
export const SubagentQuestion: Story = { args: { part: part(J.subagentAsked) }, play: openCard };
export const QuestionPending: Story = { args: { part: part(J.peerPending) }, play: openCard };
export const PeerQuestionAnswered: Story = { args: { part: part(J.peerAnswered) }, play: openCard };
export const Mobile: Story = { args: { part: part(J.runningTail) }, globals: { viewport: { value: "phone" } } };
