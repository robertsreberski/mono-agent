import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { AgentSettingsScreen } from "../../components/agent-settings/AgentSettingsScreen";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { setSettingsDraft, discardSettingsDraft } from "../../settings-drafts";
import { atlas } from "../fixtures";
import { storyStore } from "../store";

type Variant = "base" | "dense" | "offline" | "unsaved" | "confirm" | "progress" | "success";
const select = (variant: Variant) => {
  const sourceId = `atlas-story-settings-${variant}`;
  Object.assign(storyStore, { selectedAgent: { ...atlas, sourceId, status: variant === "offline" ? "offline" : "online", pinned: true,
    supportsProviderAuth: true, supportsProviderUsage: true, supportsProviderUsageRefresh: true, supportsProviderAuthChecks: true,
    restart: { supported: true }, providers: [{ id: "atlas", label: "Atlas Cloud", configured: true }, { id: "grove", label: "Grove Research Cloud", configured: true }],
  }, selectedAgentId: sourceId, activeThreads: { ...storyStore.activeThreads, runningCounts: { [sourceId]: 1 } } });
  if (variant === "unsaved") setSettingsDraft(sourceId, { model: "grove/fast", effort: "low" });
};
function Preview({ variant, section, layout }: { readonly variant: Variant; readonly section: "new-conversations" | "providers" | "agent" | null; readonly layout: "split" | "stacked" }) {
  select(variant);
  useEffect(() => () => { discardSettingsDraft(`atlas-story-settings-${variant}`); Object.assign(storyStore, { selectedAgent: atlas, selectedAgentId: atlas.sourceId }); }, [variant]);
  return <div className="app-shell is-settings-open"><div className="dashboard-panel" aria-hidden={layout === "stacked" || undefined} inert={layout === "stacked"}><Dashboard /></div><div className="chat-region" aria-hidden="true" inert /><div className="settings-region"><AgentSettingsScreen section={section} layout={layout} onSection={() => undefined} onBack={() => undefined} onClose={() => undefined} onNotice={() => undefined} /></div></div>;
}
async function waitForButton(root: HTMLElement, label: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const button = [...root.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
    if (button) return button;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Story control ${label} did not appear`);
}
export default { title: "Dialogs & Settings/AgentSettingsScreen", component: Preview, tags: ["autodocs"] } satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
const desktop = { args: { variant: "base" as const, section: "new-conversations" as const, layout: "split" as const } };
const phone = { args: { variant: "base" as const, section: null, layout: "stacked" as const }, globals: { viewport: { value: "phone" } } };
export const Desktop: Story = desktop;
export const DesktopProvidersDense: Story = { args: { ...desktop.args, variant: "dense", section: "providers" } };
export const DesktopAgent: Story = { args: { ...desktop.args, section: "agent" } };
export const DesktopAgentConfirm: Story = { args: { ...desktop.args, variant: "confirm", section: "agent" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); } };
export const DesktopUnsaved: Story = { args: { ...desktop.args, variant: "unsaved" } };
export const DesktopOffline: Story = { args: { ...desktop.args, variant: "offline" } };
export const Tablet901: Story = { ...desktop, globals: { viewport: { value: "tablet" } } };
export const Tablet1060: Story = desktop;
export const Tablet1101: Story = desktop;
export const PhoneIndex: Story = phone;
export const PhoneNewConversationsUnsaved: Story = { args: { ...phone.args, variant: "unsaved", section: "new-conversations" } };
export const PhoneProvidersDense: Story = { args: { ...phone.args, variant: "dense", section: "providers" } };
export const PhoneProvidersStress: Story = { args: { ...phone.args, variant: "dense", section: "providers" } };
export const PhoneAgent: Story = { args: { ...phone.args, section: "agent" } };
export const PhoneAgentConfirm: Story = { args: { ...phone.args, variant: "confirm", section: "agent" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); } };
export const PhoneAgentInProgress: Story = { args: { ...phone.args, variant: "progress", section: "agent" } };
export const PhoneAgentBackOnline: Story = { args: { ...phone.args, variant: "success", section: "agent" }, play: async ({ canvasElement }) => { (await waitForButton(canvasElement, "Restart Atlas")).click(); (await waitForButton(canvasElement, "Confirm restart")).click(); } };
export const PhoneOffline: Story = { args: { ...phone.args, variant: "offline" } };
