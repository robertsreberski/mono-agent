import type { Meta, StoryObj } from "@storybook/react-vite";
import { SkillBrowser } from "../../components/assistant-ui/SkillPicker";
import type { SkillInfo } from "../../types";
import { openOverlay } from "../overlay-play";

const skills: SkillInfo[] = [
  { name: "garden-planning", description: "Sketch a fictional garden plan", reference: "$garden-planning", availability: "on-demand" },
  { name: "garden-notes", description: "Summarize a garden notebook", reference: "$garden-notes", availability: "inlined" },
];
const open: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await openOverlay(canvasElement, 'button[aria-label="Browse skills"]', '.skill-browser-popup');
};
export default { title: "Chat & Messages/SkillBrowser", component: SkillBrowser, tags: ["autodocs"] } satisfies Meta<typeof SkillBrowser>;
type Story = StoryObj<typeof SkillBrowser>;
export const Closed: Story = { args: { agentLabel: "Atlas", registry: { status: "ready", items: skills, total: skills.length }, onBeforeOpen: () => {}, onSelect: () => {} } };
export const Open: Story = { args: Closed.args, play: open };
export const Empty: Story = { args: { ...Closed.args!, registry: { status: "ready", items: [], total: 0 } }, play: open };
export const Mobile: Story = { args: Closed.args, play: open, globals: { viewport: { value: "phone" } } };
