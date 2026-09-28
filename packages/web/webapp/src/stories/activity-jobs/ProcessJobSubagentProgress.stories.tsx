import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobSubagentProgress } from "../../components/ProcessJobSubagentProgress";
import * as J from "../job-fixtures";

const progress = (job: J.Job) => (job.kind === "internal" ? job.subagentProgress : undefined);
const running = progress(J.subagentRunning)!;
const finished = progress(J.subagentDone)!;

export default {
  title: "Activity & Jobs/ProcessJobSubagentProgress",
  component: ProcessJobSubagentProgress,
  tags: ["autodocs"],
  decorators: [(Story) => <div className="process-job-stack is-open" style={{ maxHeight: "none", padding: 6 }}><div className="process-job-card" data-tone="running"><div className="process-job-content"><Story /></div></div></div>],
} satisfies Meta<typeof ProcessJobSubagentProgress>;
type Story = StoryObj<typeof ProcessJobSubagentProgress>;

export const Running: Story = { args: { open: true, progress: running } };
export const FinishedWithReport: Story = { args: { open: true, progress: finished } };
export const LatestOfMany: Story = {
  args: {
    open: true,
    progress: { ...finished, toolCalls: 60, recent: Array.from({ length: 50 }, (_, index) => ({
      id: `many-${String(index)}`,
      toolName: index % 3 === 0 ? "Read" : index % 3 === 1 ? "Grep" : "Bash",
      argsSummary: index % 3 === 2 ? "pnpm test -- beds" : `~/projects/garden-planner/beds/bed-${String(index)}.md`,
      status: index === 17 ? "failed" as const : "complete" as const,
      executionMs: 20 + index,
    })) },
  },
};
export const NoCallsYet: Story = { args: { open: true, progress: { ...running, toolCalls: 0, failedCalls: 0, recent: [] } } };
export const Unavailable: Story = { args: { open: true } };
