import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ActivityRow, ActivityPayload, TruncationNotice } from "../components/ActivityRow";
import { BrandMark } from "../components/BrandMark";
import { Icon } from "../components/Icon";
import { DataModeIndicator } from "../components/DataModeIndicator";
import { RouteBadge } from "../components/RouteBadge";
import { MessageGallery, ImageGrid } from "../components/ImageGallery";
import { ProviderUsageMeters } from "../components/ProviderUsageMeters";
import { RootErrorFallback, ConversationErrorFallback } from "../components/RenderErrorBoundary";
import { QuoteBlock } from "../components/assistant-ui/Quote";
import { ActivityElapsed } from "../components/assistant-ui/ActivityElapsed";
import { ModelSelector } from "../components/assistant-ui/ModelSelector";
import { ContextDisplay } from "../components/assistant-ui/ContextDisplay";
import { TagChip } from "../components/tag/TagChip";
import { ProjectTag } from "../components/project/ProjectTag";
import { DashboardSearch } from "../components/dashboard/DashboardSearch";
import { ConnectionBanner } from "../components/Chat";
import { WakeScheduleStatus } from "../components/WakeScheduleStatus";
import { RestartAgentCard } from "../components/RestartAgentCard";
import { thread } from "../test/fixtures";

const icons = ["agent", "search", "terminal", "folder", "star", "close", "chevron-down", "bulb"] as const;
function Primitives() {
  const [search, setSearch] = useState("Garden planner");
  const [model, setModel] = useState("atlas/standard");
  const [effort, setEffort] = useState("medium");
  return <div style={{ display: "grid", gap: 28, maxWidth: 800 }}>
    <section><h2>Identity & iconography</h2><BrandMark /><div style={{ display: "flex", gap: 16 }}>{icons.map((name) => <span title={name} key={name}><Icon name={name} size={24} /></span>)}</div></section>
    <section><h2>Routes</h2><RouteBadge modelShort="Atlas" effortShort="medium" label="Atlas, medium effort" title="Atlas, medium effort" /> <RouteBadge modelShort="Grove" effortShort="low" label="Requested Grove, low effort" title="Requested Grove, low effort" fallback /></section>
    <section><h2>Tags</h2><TagChip tag={{ name: "Research", color: "green" }} /> <ProjectTag name="Garden planner" color="blue" /></section>
    <section><h2>Activity: completed, running, failed</h2>{(["complete", "running", "failed"] as const).map((status) => <ActivityRow key={status} status={status} label="Read" summary="garden/outline.md" duration="1.2s"><ActivityPayload args={{ file: "garden/outline.md" }} result={status === "failed" ? undefined : "Ready"} error={status === "failed" ? "File unavailable" : undefined} /></ActivityRow>)}<TruncationNotice characters={1200} onLoadFull={async () => false} /></section>
    <section><h2>Search</h2><DashboardSearch value={search} onChange={setSearch} /></section>
    <section><h2>Connection</h2><ConnectionBanner connection="reconnecting" /><DataModeIndicator /></section>
    <section><h2>Selection</h2><ModelSelector models={[{ id: "atlas/standard", name: "Atlas Standard", provider: "atlas", providerLabel: "Atlas", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }] }, { id: "grove/fast", name: "Grove Fast", provider: "grove", providerLabel: "Grove", efforts: [] }]} value={model} effort={effort} onValueChange={setModel} onEffortChange={setEffort} /></section>
    <section><h2>Skill suggestions</h2><p>Skill suggestions mount within the composer's trigger popover (see Chat & Messages).</p></section>
    <section><h2>Context and timing</h2><ContextDisplay context={{ status: "current", usage: { total: 6400, contextWindow: 32000 } }} processed={{ input: 3200, output: 1200 }} conversationCost={0.02} /> <ActivityElapsed timing={{ startedAt: Date.parse("2026-01-15T10:00:00Z"), finishedAt: Date.parse("2026-01-15T10:00:02Z") }} live={false} /></section>
    <section><h2>Quote</h2><QuoteBlock text="Morgan's garden planner has two drafts." messageId="example-message" /></section>
    <section><h2>Schedule</h2><WakeScheduleStatus thread={thread("garden", "atlas", { wakeSchedule: { state: "active", nextFireAt: "2026-01-16T10:00:00Z" } } as Parameters<typeof thread>[2])} /></section>
  </div>;
}
export default { title: "Primitives/Component gallery", component: Primitives, tags: ["autodocs"] } satisfies Meta<typeof Primitives>;
export const States: StoryObj<typeof Primitives> = {};
export const Mobile: StoryObj<typeof Primitives> = { globals: { viewport: { value: "phone" } } };
export const Empty: StoryObj<typeof Primitives> = { render: () => <><h2>Empty & loading</h2><ConnectionBanner connection="connecting" /><ContextDisplay context={{ status: "awaiting_measurement" }} /></> };
export const Failures: StoryObj<typeof Primitives> = { render: () => <><h2>Error recovery</h2><ConversationErrorFallback error={new Error("Example render failure")} reset={() => {}} /><RootErrorFallback reload={() => {}} /></> };
export const Restart: StoryObj<typeof Primitives> = { render: () => <RestartAgentCard sourceId="atlas" agentLabel="Atlas" reason="Apply a local configuration change" unavailableReason="No supervisor available in preview" /> };
export const Images: StoryObj<typeof Primitives> = { render: () => <MessageGallery><p>Fictional garden illustration</p><ImageGrid images={[{ key: "garden-image", name: "Garden illustration", src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='120'%3E%3Crect width='240' height='120' fill='%2324725f'/%3E%3C/svg%3E" }]} /></MessageGallery> };
export const Usage: StoryObj<typeof Primitives> = { render: () => <ProviderUsageMeters usage={{ providerId: "anthropic", label: "Example provider", fetchedAt: "2026-01-15T10:00:00Z", stale: false, windows: [{ kind: "session", label: "Session", usedPercent: 42, periodMs: 18000000 }] }} /> };
export const Offline: StoryObj<typeof Primitives> = { render: () => <ConnectionBanner connection="offline" /> };
