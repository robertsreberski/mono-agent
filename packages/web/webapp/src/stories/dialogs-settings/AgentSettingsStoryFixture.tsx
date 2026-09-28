import { useEffect } from "react";
import { AgentSettingsScreen } from "../../components/agent-settings/AgentSettingsScreen";
import { Dashboard } from "../../components/dashboard/Dashboard";
import { setSettingsDraft, discardSettingsDraft } from "../../settings-drafts";
import { atlas } from "../fixtures";
import { storyStore } from "../store";

export type Variant = "base" | "dense" | "stress" | "offline" | "unsaved" | "confirm" | "progress" | "success" | "override" | "draft-use" | "saving" | "save-error" | "loading" | "read-error" | "failure" | "not-confirmed" | "unsupported" | "unpinned" | "usage-only" | "no-usage" | "needs-action" | "usage-stale";
const defaultSave = storyStore.setAgentRunDefaults;
const select = (variant: Variant) => {
  Object.assign(storyStore, { setAgentRunDefaults: variant === "saving" ? () => new Promise<void>(() => undefined) : variant === "save-error" ? async () => { throw new Error("Example save unavailable"); } : defaultSave,
    catalogByProvider: variant === "loading" ? { atlas: { status: "loading", models: [] } } : {} });
  const sourceId = `atlas-story-settings-${variant}`;
  Object.assign(storyStore, { selectedAgent: { ...atlas, sourceId, status: variant === "offline" ? "offline" : "online", pinned: variant !== "unpinned",
    supportsProviderUsageRefresh: variant !== "no-usage" ? true : undefined, supportsProviderAuthChecks: variant !== "usage-only" ? true : undefined,
    restart: variant === "unsupported" ? { supported: false, reason: "Restart is unavailable for this example agent." } : { supported: true },
    supportsProviderAuth: variant !== "usage-only" ? true : undefined, supportsProviderUsage: variant !== "no-usage" ? true : undefined, providers: [{ id: "atlas", label: "Atlas Cloud", configured: true }, { id: "grove", label: "Grove Research Cloud", configured: true }],
    models: ["atlas/standard", "grove/fast"], defaultModel: "atlas/standard", defaultEffort: "medium",
    modelOptions: { "atlas/standard": { label: "Atlas Standard", reasoning: true, effortLevels: ["low", "medium", "high"] }, "grove/fast": { label: "Grove Fast", reasoning: true, effortLevels: ["low", "medium", "high"] } },
    runSettings: { config: { model: "atlas/standard", effort: "medium" }, override: ["override", "draft-use"].includes(variant) ? { model: "grove/fast", effort: "low" } : null, effective: ["override", "draft-use"].includes(variant) ? { model: "grove/fast", effort: "low", modelSource: "override", effortSource: "override" } : { model: "atlas/standard", effort: "medium", modelSource: "config", effortSource: "config" } },
    ...(variant === "loading" ? { models: ["atlas/pending"], defaultModel: "atlas/pending", modelOptions: {}, runSettings: { config: { model: "atlas/pending" }, override: null, effective: { model: "atlas/pending", modelSource: "config", effortSource: "config" } } } : {}),
  }, selectedAgentId: sourceId, activeThreads: { ...storyStore.activeThreads, runningCounts: { [sourceId]: 1 } } });
  if (["unsaved", "saving", "save-error"].includes(variant)) setSettingsDraft(sourceId, { model: "grove/fast", effort: "low" });
  if (variant === "draft-use") setSettingsDraft(sourceId, { model: "", effort: "" });
};
export function Preview({ variant, section, layout }: { readonly variant: Variant; readonly section: "new-conversations" | "providers" | "agent" | null; readonly layout: "split" | "stacked" }) {
  select(variant);
  useEffect(() => () => { discardSettingsDraft(`atlas-story-settings-${variant}`); Object.assign(storyStore, { selectedAgent: atlas, selectedAgentId: atlas.sourceId, setAgentRunDefaults: defaultSave, catalogByProvider: {} }); }, [variant]);
  return <div className="app-shell is-settings-open"><div className="dashboard-panel" aria-hidden={layout === "stacked" || undefined} inert={layout === "stacked"}><Dashboard /></div><div className="chat-region" aria-hidden="true" inert /><div className="settings-region"><AgentSettingsScreen section={section} layout={layout} onSection={() => undefined} onBack={() => undefined} onClose={() => undefined} onNotice={() => undefined} /></div></div>;
}
export async function waitForButton(root: HTMLElement, label: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const button = [...root.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
    if (button) return button;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Story control ${label} did not appear`);
}
