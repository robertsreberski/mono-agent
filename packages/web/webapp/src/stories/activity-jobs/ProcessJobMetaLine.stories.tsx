import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobMetaLine } from "../../components/ProcessJobSubagentProgress";
import * as J from "../job-fixtures";

const progress = (job: J.Job) => (job.kind === "internal" ? job.subagentProgress : undefined);
const running = progress(J.subagentRunning);
const finished = progress(J.subagentDone);

export default {
  title: "Activity & Jobs/ProcessJobMetaLine",
  component: ProcessJobMetaLine,
  tags: ["autodocs"],
  decorators: [(Story) => <div className="process-job-content" style={{ paddingLeft: 0 }}><Story /></div>],
} satisfies Meta<typeof ProcessJobMetaLine>;
type Story = StoryObj<typeof ProcessJobMetaLine>;

export const SubagentRunning: Story = { args: { status: "running", ...(running === undefined ? {} : { progress: running }) } };
export const SubagentFinished: Story = { args: { status: "complete", ...(finished === undefined ? {} : { progress: finished }), supplements: [<span key="cost">$0.42</span>] } };
export const FallbackRoute: Story = {
  args: {
    status: "complete",
    ...(finished === undefined ? {} : { progress: { ...finished, route: {
      requested: { model: "atlas/standard", effort: "high" },
      executed: { model: "grove/fast", effort: "medium" },
      disposition: "fallback" as const,
    } } }),
  },
};
export const WakeSupplement: Story = { args: { status: "complete", supplements: [<span key="wake">wake failed (3 attempts)</span>] } };
export const Empty: Story = { args: { status: "complete" } };
