import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecentSection } from "../../components/dashboard/RecentSection";
import { StoryRuntime } from "../runtime";
const search = { status: "idle" as const, hits: [], truncated: false };
export default { title: "Dashboard/RecentSection", component: RecentSection, tags: ["autodocs"], decorators: [(Story) => <StoryRuntime><div style={{ width: 360, maxWidth: "100%" }}><Story /></div></StoryRuntime>] } satisfies Meta<typeof RecentSection>;
type Story = StoryObj<typeof RecentSection>;
export const Threads: Story = { args: { searching: false, query: "", search } };
export const Searching: Story = { args: { searching: true, query: "garden", search: { ...search, status: "loading" } } };
export const Mobile: Story = { args: { ...Threads.args!, highlightSelected: false }, globals: { viewport: { value: "phone" } } };
