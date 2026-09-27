import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobStack } from "../../components/ProcessJobStack";
import { ProcessJobPresentationProvider } from "../../process-job-presentation";
import { jobPart } from "../fixtures";

const active = { messageId: "example-1", part: { ...jobPart("running"), job: { ...jobPart("running").job, jobId: "11111111-1111-4111-8111-111111111111" } } };
const done = { messageId: "example-2", part: { ...jobPart("succeeded"), job: { ...jobPart("succeeded").job, jobId: "22222222-2222-4222-8222-222222222222" } } };
const failed = { messageId: "example-3", part: { ...jobPart("failed"), job: { ...jobPart("failed").job, jobId: "33333333-3333-4333-8333-333333333333" } } };
const stack = (jobs: typeof active[]) => <ProcessJobPresentationProvider threadId="example" messages={[]} jobs={jobs} historyIsBounded={false}><ProcessJobStack /></ProcessJobPresentationProvider>;
export default { title: "Activity & Jobs/ProcessJobStack", component: ProcessJobStack, tags: ["autodocs"] } satisfies Meta<typeof ProcessJobStack>;
type Story = StoryObj<typeof ProcessJobStack>;
export const ActiveAndHistory: Story = { render: () => stack([active, done, failed]) };
export const HistoryOnly: Story = { render: () => stack([done, failed]) };
export const Mobile: Story = { render: () => stack([active, done]), globals: { viewport: { value: "phone" } } };
