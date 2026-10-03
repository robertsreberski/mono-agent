import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobPeerQuestion } from "../../components/ProcessJob";
import * as J from "../job-fixtures";

const question = (job: J.Job) => (job.kind === "internal" ? job.peerQuestion : undefined)!;
const pending = question(J.peerPending);

export default {
  title: "Activity & Jobs/ProcessJobPeerQuestion",
  component: ProcessJobPeerQuestion,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "A PeerAgent's question, shown as untrusted reference text: the agent answers it through PeerAgent, never through the console." } } },
  decorators: [(Story) => <div style={{ maxWidth: 640 }}><Story /></div>],
} satisfies Meta<typeof ProcessJobPeerQuestion>;
type Story = StoryObj<typeof ProcessJobPeerQuestion>;

export const Awaiting: Story = { args: { question: pending } };
export const Answered: Story = { args: { question: question(J.peerAnswered) } };
export const Expired: Story = { args: { question: { ...pending, state: "expired" } } };
export const RawFormOnly: Story = { args: { question: { ...pending, requestedSchema: { type: "object", description: "A peer form the console cannot read" } } } };
export const LongMessage: Story = {
  args: { question: { ...pending, message: "Before I place the spring order I need a decision about the heirloom tomatoes, the bean trellis budget and whether Morgan's community plot should share the seed reservation with the school garden this year." } },
};
export const Mobile: Story = { args: { question: pending }, globals: { viewport: { value: "phone" } } };
