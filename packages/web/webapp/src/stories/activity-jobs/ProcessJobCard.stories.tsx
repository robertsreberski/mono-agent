import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobCard } from "../../components/ProcessJob";
import { jobPart } from "../fixtures";

export default {
  title: "Activity & Jobs/ProcessJobCard",
  component: ProcessJobCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: { part: { control: "object", description: "Persisted, fictional job projection; not a polling live job." } },
} satisfies Meta<typeof ProcessJobCard>;
type Story = StoryObj<typeof ProcessJobCard>;
export const Queued: Story = { args: { part: jobPart("queued") } };
export const Starting: Story = { args: { part: jobPart("starting") } };
export const Running: Story = { args: { part: jobPart("running", "Reading the garden plan...\nPreparing a new outline...\n") } };
export const Succeeded: Story = { args: { part: jobPart("succeeded") } };
export const Failed: Story = { args: { part: jobPart("failed", "The example task could not finish.\n") } };
export const LongOutput: Story = { args: { part: jobPart("succeeded", Array.from({ length: 40 }, (_, index) => `${String(index + 1)}. Garden bed: plan a fictional planting cycle.\n`).join("")) } };
export const Mobile: Story = { args: { part: jobPart("running", "Preparing a mobile garden plan...\n") }, globals: { viewport: { value: "phone" } } };
