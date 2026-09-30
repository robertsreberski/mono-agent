import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { App } from "./App";
import { AuthGate } from "./auth";
import { setMultiUser } from "./auth-state";
import { ConsoleStoreProvider } from "./console-store";
import { WebRuntimeProvider } from "./runtime";
import { NotificationsProvider } from "./notifications";
import { createThreadPersistence } from "./thread-persistence";
import { agent, bootstrap, thread } from "./test/fixtures";
import type { WebUser } from "../../src/auth-contracts";
import type { CronJob, WebMessage } from "./types";
import "./styles.css";

const riley: WebUser = { id: "riley", username: "riley", displayName: "Riley", role: "admin", disabled: false, version: 1, grants: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const morgan: WebUser = { ...riley, id: "morgan", username: "morgan", displayName: "Morgan", role: "user", grants: ["alpha"] };
const agents = [agent("alpha", { label: "Studio", cron: { read: true, actions: true } }), agent("beta", { label: "Workshop" })];
let shared = thread("shared-chat", "alpha", { title: "Plan the community garden", messageCount: 3, shared: true, ownerUserId: "riley", creatorDisplayName: "Riley" });
const message = (id: string, text: string, sender?: WebUser): WebMessage => ({ id, threadId: shared.id, role: sender ? "user" : "assistant", parts: [{ type: "text", text }], attachments: [], createdAt: "2026-01-01T10:00:00Z", updatedAt: "2026-01-01T10:00:00Z", status: "complete", ...(sender ? { sender: { id: sender.id, displayName: sender.displayName } } : {}) });
const messages = [message("one", "Let's sketch a community garden for spring.", riley), message("two", "I can help choose flowers for the raised beds.", morgan), message("three", "Start with a sunny spot, a shared planting calendar, and native flowers.")];
const cronJob: CronJob = { jobId: "garden-reminder", configured: true, expression: "0 9 * * 1", timezone: "UTC", declaredEnabled: true, effectiveEnabled: true, health: "unknown", resultsPrivate: true };
let currentUser: WebUser | null;
let multiUser = true;
class Events {
  static instances: Events[] = [];
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() { Events.instances.push(this); }
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2; }
  emit(type: string, payload: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ version: 1, type, at: new Date().toISOString(), payload }) })); }
}
const shots = import.meta.env.VITE_MULTI_USER_SHOTS as string | undefined;
const capture = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const open = () => render(<AuthGate><ConsoleStoreProvider><NotificationsProvider><WebRuntimeProvider><App /></WebRuntimeProvider></NotificationsProvider></ConsoleStoreProvider></AuthGate>);
const settled = async () => { expect(await screen.findByText("Start with a sunny spot, a shared planting calendar, and native flowers.")).toBeInTheDocument(); };

beforeEach(async () => {
  setMultiUser(false); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
  currentUser = riley; multiUser = true; Events.instances = [];
  shared = { ...shared, shared: true, runState: { status: "idle" }, archivedAt: null };
  vi.stubGlobal("EventSource", Events);
  vi.spyOn(api, "authStatus").mockImplementation(async () => ({ multiUser, user: currentUser }));
  vi.spyOn(api, "login").mockImplementation(async () => { currentUser = riley; return { user: riley }; });
  vi.spyOn(api, "logout").mockImplementation(async () => { currentUser = null; });
  vi.spyOn(api, "bootstrap").mockImplementation(async () => bootstrap(agents, [shared], shared.id));
  vi.spyOn(api, "thread").mockImplementation(async () => ({ thread: shared, messages }));
  vi.spyOn(api, "threadIfChanged").mockImplementation(async () => ({ thread: shared, messages }));
  vi.spyOn(api, "threads").mockImplementation(async () => ({ threads: [shared] }));
  vi.spyOn(api, "activeThreads").mockResolvedValue({ threads: [], total: 0, truncated: false, runningCounts: { alpha: 0, beta: 0 } });
  vi.spyOn(api, "agentModels").mockResolvedValue({ models: [], truncated: false });
  vi.spyOn(api, "agentSkills").mockResolvedValue({ status: "unsupported", items: [] });
  vi.spyOn(api, "projects").mockResolvedValue([]);
  vi.spyOn(api, "listTags").mockResolvedValue([]);
  vi.spyOn(api, "pendingAsk").mockResolvedValue(undefined);
  vi.spyOn(api, "cronOverview").mockResolvedValue({ jobs: [cronJob], actionsEnabled: true, generatedAt: "2026-01-01T10:00:00Z" });
  vi.spyOn(api, "patchThread").mockImplementation(async (_id, patch) => { shared = { ...shared, ...(patch.shared === undefined ? {} : { shared: patch.shared }), revision: shared.revision + 1 }; return shared; });
  vi.spyOn(api, "users").mockResolvedValue({ users: [riley, morgan] });
  vi.spyOn(api, "latestAgentRestart").mockResolvedValue(null);
  vi.spyOn(api, "providerAuthStatus").mockResolvedValue({ providers: [] } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setMultiUser(false); });

for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) describe(name, () => {
  it("shows the accessible login panel, then the shared conversation", async () => {
    await page.viewport(width, height); currentUser = null;
    open();
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeVisible();
    expect(api.bootstrap).not.toHaveBeenCalled();
    await capture(`login-${name}`);
    await userEvent.fill(screen.getByLabelText("Username"), "riley");
    await userEvent.fill(screen.getByLabelText("Password"), "fictional-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await settled();
    if (name === "mobile") await userEvent.click(screen.getByRole("button", { name: "Open Plan the community garden" }));
    expect(screen.getAllByText("Shared · Riley").length).toBeGreaterThan(0);
    expect(screen.getByText("Riley", { selector: ".message-sender" })).toBeVisible();
    expect(screen.getByText("Morgan", { selector: ".message-sender" })).toBeVisible();
    await capture(`shared-conversation-${name}`);
  });
  it("edits users with discovered-agent grants", async () => {
    await page.viewport(width, height); open(); await settled();
    await userEvent.click(screen.getByRole("button", { name: "Your profile" }));
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await userEvent.click(await screen.findByRole("button", { name: "Morgan · morgan" }));
    expect(screen.getByRole("checkbox", { name: "Studio" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Workshop" })).not.toBeChecked();
    await capture(`admin-users-${name}`);
  });
  it("keeps cron controls but renders private results without a history link", async () => {
    await page.viewport(width, height); currentUser = morgan; open(); await settled();
    await userEvent.click(screen.getByRole("button", { name: /^Automations/ }));
    expect(await screen.findByText(/Private results/, { selector: ".thread-preview-text" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open run history for garden-reminder" })).toBeNull();
    Events.instances.at(-1)?.emit("ready", {});
    await userEvent.click(screen.getByText(/0 9 \* \* 1 · Enabled · Next/));
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    await capture(`private-cron-results-${name}`);
  });
  it("hides administrator surfaces for a regular user, including deep links and palette entries", async () => {
    await page.viewport(width, height); currentUser = morgan;
    window.history.replaceState(null, "", "/?settings=providers"); open(); await settled();
    expect(screen.queryByRole("button", { name: "Agent settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: /notifications/i })).toBeNull();
    expect(api.latestAgentRestart).not.toHaveBeenCalled();
    expect(api.providerAuthStatus).not.toHaveBeenCalled();
    await capture(`regular-user-${name}`);
    window.dispatchEvent(new Event("mono-agent:agent-settings"));
    expect(screen.queryByText("Providers", { selector: "h2" })).toBeNull();
    window.dispatchEvent(new Event("mono-agent:command"));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Agent settings/ })).toBeNull();
  });
});

it("only the idle creator can change sharing, with whole-history confirmation", async () => {
  await page.viewport(1440, 900); open(); await settled();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Make private" }));
  await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(shared.id, { shared: false }, expect.any(AbortSignal)));
  await waitFor(() => expect(screen.queryByText("Shared · Riley")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Share with everyone allowed on this agent" }));
  expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("whole conversation history"));
});
it("hides share/delete from non-creators and clears removed conversations and durable data", async () => {
  await page.viewport(1440, 900); currentUser = morgan; open(); await settled();
  await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
  expect(screen.queryByRole("menuitem", { name: "Make private" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Permanently delete" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  Events.instances.at(-1)?.emit("thread.changed", { threadId: shared.id, removed: true });
  await waitFor(() => expect(screen.queryByText("I can help choose flowers for the raised beds.")).toBeNull());
  const persistence = createThreadPersistence();
  expect(await persistence.hydrate()).toMatchObject({ snapshot: null, threads: [], buckets: [] }); persistence.close();
});
it("disables sharing while a creator conversation is running", async () => {
  await page.viewport(1440, 900); shared = { ...shared, runState: { status: "running" } }; open(); await settled();
  await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
  expect(await screen.findByRole("menuitem", { name: "Make private" })).toHaveAttribute("aria-disabled", "true");
});
