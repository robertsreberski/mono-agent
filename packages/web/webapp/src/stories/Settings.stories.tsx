import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { AgentSettingsDialog } from "../components/AgentSettingsDialog";
import { ProjectSettingsSheet } from "../components/project/ProjectSettingsSheet";
import { TagSettingsSheet } from "../components/tag/TagSettingsSheet";
import { WakeScheduleEditor } from "../components/WakeScheduleEditor";
import { storyStore } from "./store";

function Settings({ kind }: { kind: "agent" | "project" | "tag" | "wake" }) {
  const ref = useRef<HTMLElement>(null);
  return <><p>Fictional Atlas agent / Garden planner project</p>
    {kind === "agent" && <AgentSettingsDialog open onClose={() => {}} dialogRef={ref} />}
    {kind === "project" && <ProjectSettingsSheet sheet={{ mode: "create", sourceId: "atlas" }} onClose={() => {}} dialogRef={ref} />}
    {kind === "tag" && <TagSettingsSheet sheet={{ mode: "create", sourceId: "atlas" }} onClose={() => {}} dialogRef={ref} />}
    {kind === "wake" && <WakeScheduleEditor thread={storyStore.threads[0]!} onClose={() => {}} />}
  </>;
}
export default { title: "Dialogs & Settings/Forms", component: Settings, tags: ["autodocs"] } satisfies Meta<typeof Settings>;
export const Agent: StoryObj<typeof Settings> = { args: { kind: "agent" } };
export const Project: StoryObj<typeof Settings> = { args: { kind: "project" } };
export const Tag: StoryObj<typeof Settings> = { args: { kind: "tag" } };
export const WakeSchedule: StoryObj<typeof Settings> = { args: { kind: "wake" } };
export const Mobile: StoryObj<typeof Settings> = { args: { kind: "project" }, globals: { viewport: { value: "phone" } } };
