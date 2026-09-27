// Storybook-only replacement for the console store. No bootstrap, SSE, or API
// connection is made. Stories may switch the selected fixtures without changing
// any application module or injecting operator data into the public repository.
import { agent, project, thread, uploadLimits } from "../test/fixtures";

const atlas = agent("atlas", { label: "Atlas", pinned: true });
const grove = agent("grove", { label: "Grove", status: "offline" });
const planning = thread("garden-planner", "atlas", { title: "Garden planner", messageCount: 8 });
const running = thread("seed-catalog", "atlas", { title: "Seed catalog", runState: { status: "running" }, messageCount: 3 });
const garden = project("garden", "atlas", { name: "Garden planner", color: "blue", conversationCount: 2 });
const noop = () => {};
const asyncNoop = async () => undefined;
export const storyStore = {
  bootstrap: { console: { hostName: "fictional", displayName: "Garden console", theme: "evergreen" }, limits: uploadLimits },
  connection: "live", agents: [atlas, grove], visibleAgents: [atlas, grove], selectedAgent: atlas,
  selectedAgentId: "atlas", selectedThreadId: planning.id, selectedThread: planning,
  threads: [planning, running], visibleThreads: [planning, running],
  activeThreads: { threads: [running], total: 1, truncated: false, authoritative: true, runningCounts: { atlas: 1 } },
  cachedRunningThreads: [], unreadThreadIds: new Set<string>(), unreadCountByAgent: new Map<string, number>(),
  projectsByAgent: { atlas: [garden] }, tagsByAgent: { atlas: [] }, openProject: null, openProjectId: null,
  hiddenOfflineAgentCount: 0, showOfflineAgents: false, showArchived: false,
  navigationDestination: "chats", catalogByProvider: {}, cronOverview: null,
  cronLoading: false, cronError: null, selectionLoading: false, creatingThread: false,
  selectionError: null, threadListError: null, hasMoreThreads: false,
  selectedThreadDetail: null, messages: [], providerAuth: null,
  projectMembers: [planning, running], projectMembersLoading: false,
  projectMembersError: null, hasMoreProjectMembers: false,
  closeProject: noop, loadMoreProjectMembers: asyncNoop,
  modelOptions: [], effortOptions: [], skillRegistry: { status: "ready", items: [] },
  attachments: [], runSettings: atlas.runSettings,
  cancelTurn: asyncNoop, sendMessage: asyncNoop,
  selectAgent: noop, selectThread: noop, selectCronJob: noop, setShowOfflineAgents: noop,
  setShowArchived: noop, setNavigationDestination: noop, openProjectById: noop,
  retryThreadList: noop, loadMoreThreads: asyncNoop, refreshCron: asyncNoop,
  setAgentPinned: asyncNoop, ensureProviderCatalog: asyncNoop, createThread: asyncNoop, updateProject: asyncNoop,
  createProject: asyncNoop, createTag: asyncNoop, updateTag: asyncNoop,
};
export const useConsoleStore = () => storyStore;
export const useUploadLimits = () => uploadLimits;
