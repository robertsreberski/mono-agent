import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityRow, ActivityPayload, ActivityStep } from "../components/ActivityRow";
import { ProcessJobCard } from "../components/ProcessJob";
import { ProcessJobSubagentProgress, ProcessJobMetaLine } from "../components/ProcessJobSubagentProgress";
import { RunAttribution } from "../components/RunAttribution";
import { processJob } from "../test/fixtures";
import type { ProcessJobState } from "../types";

const states: ProcessJobState[] = ["queued", "starting", "running", "succeeded", "failed"];
// No thread-bound origin on active cards: they show retained state without
// initiating a poll. These are examples, not a simulated running service.
const makePart = (state: ProcessJobState) => ({
  type: "process-job" as const,
  job: processJob({
    state: state as "succeeded",
    summary: "Generate garden planning notes",
    origin: { conversationId: "example", channel: "web", runId: "example-run", historyBoundary: "example", bucket: null },
    output: { stdoutBytes: 12, stderrBytes: 0, truncated: false, preview: "Plan ready\n", stdoutRef: "examples/stdout.log", stderrRef: "examples/stderr.log" },
    timestamps: { admittedAt: "2026-01-15T10:00:00Z", startedAt: "2026-01-15T10:00:01Z", completedAt: "2026-01-15T10:00:03Z", queueDeadlineAt: "2026-01-15T10:05:00Z", runtimeDeadlineAt: "2026-01-15T10:30:00Z" },
    wake: { state: "delivered", attempts: 1, deliveryKey: "example", lastAttemptAt: "2026-01-15T10:00:04Z" },
    lastError: null,
  }),
});
function Jobs() {
  return <div style={{ maxWidth: 720, display: "grid", gap: 22 }}>
    <h2>Background jobs</h2>
    {states.map((state) => <section key={state}><h3>{state}</h3><ProcessJobCard part={makePart(state)} /></section>)}
    <h2>Subagent work</h2><ProcessJobMetaLine status="running" supplements={["Garden planner"]} />
    <ProcessJobSubagentProgress open progress={undefined} />
    <h2>Tool activity</h2><ActivityRow variant="subagent" label="Atlas" summary="Plan the first planting" status="running"><ActivityStep toolName="Read"><ActivityPayload args={{ file: "garden/plan.md" }} result="Outline" /></ActivityStep></ActivityRow>
  </div>;
}
export default { title: "Activity & Jobs/Background work", component: Jobs, tags: ["autodocs"] } satisfies Meta<typeof Jobs>;
export const Lifecycle: StoryObj<typeof Jobs> = {};
export const Mobile: StoryObj<typeof Jobs> = { globals: { viewport: { value: "phone" } } };
export const Attribution: StoryObj<typeof Jobs> = { render: () => <RunAttribution status="complete" attribution={{ requested: { model: "atlas/standard", effort: "high" }, attempted: { model: "grove/fast", effort: "medium" }, executed: { model: "grove/fast", effort: "medium" }, disposition: "fallback", transitions: [{ from: "atlas/standard", to: "grove/fast", reason: "temporarily unavailable" }], retries: [] }} /> };
