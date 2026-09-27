import type { Meta, StoryObj } from "@storybook/react-vite";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { Dashboard } from "../components/dashboard/Dashboard";
import { DashboardHeader } from "../components/dashboard/DashboardHeader";
import { DashboardFooter } from "../components/dashboard/DashboardFooter";
import { AgentStrip } from "../components/dashboard/AgentStrip";
import { RunningSection } from "../components/dashboard/RunningSection";
import { ProjectsSection } from "../components/dashboard/ProjectsSection";
import { RecentSection } from "../components/dashboard/RecentSection";
import { DashboardSearch } from "../components/dashboard/DashboardSearch";
import { ThreadListItem } from "../components/dashboard/ThreadListItem";
import { ProjectPage } from "../components/project/ProjectPage";
import { ConversationTags } from "../components/tag/ConversationTags";
import { TagMenu } from "../components/tag/TagMenu";
import { AutomationsList } from "../components/AutomationsList";
import { ThreadSearchResults } from "../components/ThreadSearchResults";
import { storyStore } from "./store";

// Local assistant-ui runtime only: no transport, bootstrap, or requests.
function LocalPreview({ children }: { children: React.ReactNode }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "Example only" }] }) });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
function ConsoleScreen() {
  return <LocalPreview><div style={{ width: 370, maxWidth: "100%", height: 780, overflow: "auto", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12 }}><Dashboard /></div></LocalPreview>;
}
export default { title: "Dashboard/Console screen", component: ConsoleScreen, tags: ["autodocs"] } satisfies Meta<typeof ConsoleScreen>;
export const Desktop: StoryObj<typeof ConsoleScreen> = {};
export const Phone: StoryObj<typeof ConsoleScreen> = { globals: { viewport: { value: "phone" } } };
export const Header: StoryObj<typeof ConsoleScreen> = { render: () => <DashboardHeader /> };
export const Agents: StoryObj<typeof ConsoleScreen> = { render: () => <AgentStrip runningCounts={new Map([["atlas", 1]])} /> };
export const Search: StoryObj<typeof ConsoleScreen> = { render: () => <DashboardSearch value="garden" onChange={() => {}} /> };
export const Running: StoryObj<typeof ConsoleScreen> = { render: () => <RunningSection groups={[{ agent: storyStore.agents[0]!, threads: [storyStore.threads[1]!] }]} expandedAgentIds={new Set()} onToggleAgent={() => {}} onOpen={() => {}} total={1} catalogModels={{}} catalogSourceId="atlas" /> };
export const Projects: StoryObj<typeof ConsoleScreen> = { render: () => <ProjectsSection /> };
export const Automations: StoryObj<typeof ConsoleScreen> = { render: () => <AutomationsList query="" /> };
export const Footer: StoryObj<typeof ConsoleScreen> = { render: () => <DashboardFooter /> };
export const Recent: StoryObj<typeof ConsoleScreen> = { render: () => <LocalPreview><RecentSection searching={false} query="" search={{ status: "idle", hits: [], truncated: false }} /></LocalPreview> };
export const SearchResults: StoryObj<typeof ConsoleScreen> = { render: () => <LocalPreview><ThreadSearchResults query="garden" search={{ status: "idle", hits: [], truncated: false }} /></LocalPreview> };
export const ConversationRow: StoryObj<typeof ConsoleScreen> = { render: () => <LocalPreview><ThreadListItem thread={storyStore.threads[0]!} agent={storyStore.agents[0]!} catalogModels={{}} unread={false} highlightSelected={false} /></LocalPreview> };
export const Project: StoryObj<typeof ConsoleScreen> = { render: () => <ProjectPage project={storyStore.projectsByAgent.atlas[0]!} /> };
export const Tags: StoryObj<typeof ConsoleScreen> = { render: () => <><ConversationTags /><TagMenu thread={storyStore.threads[0]!} /></> };
