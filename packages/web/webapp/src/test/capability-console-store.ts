// Synthetic console-layout test replacement for the console store. No bootstrap, SSE, or API
// connection is made. Stories may switch the selected fixtures without changing
// any application module or injecting operator data into the public repository.
import { agent, thread, project, uploadLimits } from "./fixtures";
const atlas = agent("garden", { label: "Garden Agent · synthetic" });
const grove = agent("grove", { status: "offline" });
const planning = thread("garden-plan", "garden");
const running = thread("garden-running", "garden", { runState: { status: "running" } });
const garden = project("garden", "garden");
const researchTag = { id: "research", sourceId: "garden", name: "Research", color: "green", createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z", revision: 1 };

const noop = () => {};
const asyncNoop = async () => undefined;
export const capabilityConsoleStore = {
  bootstrap: { console: { hostName: "fictional", displayName: "Garden console", theme: "evergreen" }, limits: uploadLimits },
  connection: "live", agents: [atlas, grove], visibleAgents: [atlas, grove], selectedAgent: atlas,
  selectedAgentId: "atlas", selectedThreadId: planning.id, selectedThread: planning,
  threads: [planning, running], visibleThreads: [planning, running],
  activeThreads: { threads: [running], total: 1, truncated: false, authoritative: true, runningCounts: { atlas: 1 } },
  cachedRunningThreads: [], unreadThreadIds: new Set<string>(), unreadCountByAgent: new Map<string, number>(),
  projectsByAgent: { atlas: [garden] }, tagsByAgent: { atlas: [researchTag] }, openProject: null, openProjectId: null,
  hiddenOfflineAgentCount: 0, showOfflineAgents: false, showArchived: false,
  navigationDestination: "chats", catalogByProvider: {}, cronOverview: null,
  cronLoading: false, cronError: null, selectionLoading: false, creatingThread: false,
  selectionError: null, threadListError: null, hasMoreThreads: false,
  selectedThreadDetail: null, messages: [], providerAuth: null,
  projectMembers: [planning, running], projectMembersLoading: false,
  projectMembersError: null, hasMoreProjectMembers: false,
  closeProject: noop, loadMoreProjectMembers: asyncNoop,
  model: "atlas/standard", effort: "medium", effectiveModel: "atlas/standard", effectiveEffort: "medium",
  detail: null, hasRunOverride: false, modelOptions: ["atlas/standard"], effortOptions: ["low", "medium"],
  skillRegistry: { status: "ready", items: [], total: 0 },
  attachments: [], runSettings: atlas.runSettings,
  cancelTurn: asyncNoop, sendMessage: asyncNoop,
  setModel: noop, setEffort: noop, resetRunOverride: noop,
  selectAgent: noop, selectThread: noop, selectCronJob: noop, setShowOfflineAgents: noop,
  setShowArchived: noop, setNavigationDestination: noop, openProjectById: noop,
  retryThreadList: noop, loadMoreThreads: asyncNoop, refreshCron: asyncNoop,
  setAgentPinned: asyncNoop, setAgentRunDefaults: asyncNoop, clearAgentRunDefaults: asyncNoop,
  ensureProviderCatalog: asyncNoop, createThread: asyncNoop, updateProject: asyncNoop,
  createProject: asyncNoop, createTag: asyncNoop, updateTag: asyncNoop,
  loadTags: asyncNoop, setThreadTags: asyncNoop, loadProjects: asyncNoop,
};
export const useConsoleStore = () => capabilityConsoleStore;
export const useUploadLimits = () => uploadLimits;
