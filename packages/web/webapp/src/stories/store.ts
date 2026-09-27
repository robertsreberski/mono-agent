// Storybook-only replacement for the console store. No bootstrap, SSE, or API
// connection is made. Stories may switch the selected fixtures without changing
// any application module or injecting operator data into the public repository.
import { uploadLimits } from "../test/fixtures";
import { atlas, grove, gardenThread as planning, runningThread as running, gardenProject as garden, researchTag } from "./fixtures";
const noop = () => {};
const asyncNoop = async () => undefined;
export const storyStore = {
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
  setAgentPinned: asyncNoop, ensureProviderCatalog: asyncNoop, createThread: asyncNoop, updateProject: asyncNoop,
  createProject: asyncNoop, createTag: asyncNoop, updateTag: asyncNoop,
};
export const useConsoleStore = () => storyStore;
export const useUploadLimits = () => uploadLimits;
