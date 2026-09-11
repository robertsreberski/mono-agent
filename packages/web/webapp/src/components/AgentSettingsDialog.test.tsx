import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";
import "../styles.css";

const storeMock = vi.hoisted(() => ({
  selectedAgent: null as ReturnType<typeof agent> | null,
  catalogByProvider: {},
  ensureProviderCatalog: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
  setAgentRunDefaults: vi.fn(),
  clearAgentRunDefaults: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({
  providerAuthStatus: vi.fn(),
  beginProviderAuth: vi.fn(),
  providerAuthSession: vi.fn(),
  submitProviderAuth: vi.fn(),
  cancelProviderAuth: vi.fn(),
  beginProviderAuthCheck: vi.fn(),
  providerAuthCheck: vi.fn(),
  cancelProviderAuthCheck: vi.fn(),
}));

vi.mock("../console-store", () => ({ useConsoleStore: () => storeMock }));
vi.mock("../api", () => ({ api: apiMock }));
vi.mock("./assistant-ui/ModelSelector", () => ({
  ModelSelector: ({ onValueChange, onEffortChange }: {
    readonly onValueChange: (value: string) => void;
    readonly onEffortChange: (value: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onValueChange("provider/other")}>Choose other model</button>
      <button type="button" onClick={() => onEffortChange("high")}>Choose high effort</button>
    </div>
  ),
}));

import { AgentSettingsDialog } from "./AgentSettingsDialog";

const expectDialogTypography = (element: Element, size: "10px" | "12px") => {
  const style = window.getComputedStyle(element);
  // jsdom exposes the authored inheritance keyword; a browser resolves it to
  // the root's existing sans-serif stack.
  expect(style.fontFamily).toBe("inherit");
  expect(window.getComputedStyle(document.documentElement).fontFamily).toContain("sans-serif");
  expect(style.fontSize).toBe(size);
  expect(style.lineHeight).toBe("1.5");
};

beforeEach(() => {
  vi.resetAllMocks();
  storeMock.selectedAgent = agent("alpha", {
    label: "Alpha",
    models: ["provider/model", "provider/other"],
    modelOptions: {
      "provider/model": { effortLevels: ["low", "high"] },
      "provider/other": { effortLevels: ["low", "high"] },
    },
  });
  storeMock.setAgentRunDefaults.mockResolvedValue(undefined);
  storeMock.clearAgentRunDefaults.mockResolvedValue(undefined);
  apiMock.cancelProviderAuth.mockResolvedValue(undefined);
  apiMock.cancelProviderAuthCheck.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The start control, once it is actually a control.
 *
 * "Run check" renders WITH the section and stays disabled until the provider
 * status read lands, so a query that waits only for its presence can hand back
 * a button whose click does nothing at all -- and what then fails is the
 * assertion about whatever that click was supposed to cause, several lines
 * later and for a reason that reads like the component's.
 */
const findStartButton = async (name: string) => {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => { expect(button).toBeEnabled(); });
  return button;
};

const advanceProviderPolls = async (count = 1) => {
  await act(async () => await Promise.resolve());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(count * 1_000);
  });
};

describe("AgentSettingsDialog", () => {
  it.each(["auth", "check"] as const)("cancels a late %s admission after its dialog closes without losing the response ID", async (kind) => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true });
    apiMock.providerAuthStatus.mockResolvedValue(providerAuthStatusSnapshot("not_verified"));
    const admission = deferred<Record<string, unknown>>();
    const start = kind === "auth" ? apiMock.beginProviderAuth : apiMock.beginProviderAuthCheck;
    const cancel = kind === "auth" ? apiMock.cancelProviderAuth : apiMock.cancelProviderAuthCheck;
    start.mockReturnValueOnce(admission.promise);
    const props = { onClose: vi.fn(), dialogRef: createRef<HTMLElement>() };
    const view = render(<AgentSettingsDialog open {...props} />);
    fireEvent.click(await findStartButton(kind === "auth" ? "Re-authenticate" : "Run live checks for all displayed providers"));
    // The admission is genuinely on the wire before the dialog closes. Without
    // this the test could close over a click that started nothing -- the check
    // button is disabled until the status read lands -- and then read the
    // missing cancellation as a teardown that failed to cancel.
    await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(1); });
    view.rerender(<AgentSettingsDialog open={false} {...props} />);
    expect(cancel).not.toHaveBeenCalled();
    const snapshot = kind === "auth" ? sessionSnapshot("late-admission", "LATE FLOW") : { ...completedProviderAuthCheck(), id: "late-admission", state: "running" };
    await act(async () => admission.resolve(snapshot));
    // Awaited on the cancellation ITSELF rather than on however many turns the
    // admission's continuation happens to take: the assertion below is about
    // what is cancelled, not about when a microtask queue drained.
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalled(); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("alpha", "late-admission", expect.any(AbortSignal));
    expect(screen.queryByText("LATE FLOW")).not.toBeInTheDocument();
  });

  it.each(["auth", "check"] as const)("keeps a new scope's %s while cancelling only the old late admission", async (kind) => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", generation: "generation-1", supportsProviderAuth: true, supportsProviderAuthChecks: true });
    apiMock.providerAuthStatus.mockResolvedValue(providerAuthStatusSnapshot("not_verified"));
    const old = deferred<Record<string, unknown>>();
    const start = kind === "auth" ? apiMock.beginProviderAuth : apiMock.beginProviderAuthCheck;
    const cancel = kind === "auth" ? apiMock.cancelProviderAuth : apiMock.cancelProviderAuthCheck;
    const snapshot = (id: string) => kind === "auth" ? sessionSnapshot(id, id) : { ...completedProviderAuthCheck(), id, state: "running" };
    start.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot("NEW OWNED FLOW"));
    // Model a cancellation transport that ignores abort and never settles.
    cancel.mockReturnValueOnce(new Promise(() => undefined));
    const props = { onClose: vi.fn(), dialogRef: createRef<HTMLElement>() };
    const view = render(<AgentSettingsDialog open {...props} />);
    const action = kind === "auth" ? "Re-authenticate" : "Run live checks for all displayed providers";
    fireEvent.click(await findStartButton(action));
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", generation: "generation-2", supportsProviderAuth: true, supportsProviderAuthChecks: true });
    view.rerender(<AgentSettingsDialog open {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: action }));
    await act(async () => await Promise.resolve());
    await act(async () => {
      old.resolve(snapshot("OLD UNOWNED FLOW"));
      await old.promise;
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("alpha", "OLD UNOWNED FLOW", expect.any(AbortSignal));
    expect(screen.queryByText("OLD UNOWNED FLOW")).not.toBeInTheDocument();
    if (kind === "auth") expect(screen.getByText("NEW OWNED FLOW")).toBeVisible();
    else expect(screen.getByRole("button", { name: "Cancel live provider checks" })).toBeEnabled();
    view.unmount();
    expect(cancel).toHaveBeenLastCalledWith("alpha", "NEW OWNED FLOW", expect.any(AbortSignal));
  });

  it.each(["auth", "check"] as const)("does not cancel an already-terminal late %s admission", async (kind) => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true });
    apiMock.providerAuthStatus.mockResolvedValue(providerAuthStatusSnapshot("not_verified"));
    const late = deferred<Record<string, unknown>>();
    const start = kind === "auth" ? apiMock.beginProviderAuth : apiMock.beginProviderAuthCheck;
    const cancel = kind === "auth" ? apiMock.cancelProviderAuth : apiMock.cancelProviderAuthCheck;
    start.mockReturnValueOnce(late.promise);
    const view = render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    fireEvent.click(await findStartButton(kind === "auth" ? "Re-authenticate" : "Run live checks for all displayed providers"));
    view.unmount();
    await act(async () => late.resolve(kind === "auth" ? successfulProviderAuthSession() : completedProviderAuthCheck()));
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["auth", "check"] as const)("does not revive a cancelled %s from a same-ID poll before effect cleanup", async (kind) => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true });
    apiMock.providerAuthStatus.mockResolvedValue(providerAuthStatusSnapshot("not_verified"));
    const active = kind === "auth" ? sessionSnapshot("active", "ACTIVE FLOW") : { ...completedProviderAuthCheck(), id: "active", state: "running" };
    const start = kind === "auth" ? apiMock.beginProviderAuth : apiMock.beginProviderAuthCheck;
    const get = kind === "auth" ? apiMock.providerAuthSession : apiMock.providerAuthCheck;
    const cancel = kind === "auth" ? apiMock.cancelProviderAuth : apiMock.cancelProviderAuthCheck;
    const poll = deferred<Record<string, unknown>>();
    const deletion = deferred<void>();
    start.mockResolvedValueOnce(active);
    get.mockReturnValueOnce(poll.promise);
    cancel.mockReturnValueOnce(deletion.promise);
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const startButton = await findStartButton(kind === "auth" ? "Re-authenticate" : "Run live checks for all displayed providers");
    vi.useFakeTimers();
    fireEvent.click(startButton);
    await advanceProviderPolls();
    expect(get).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: kind === "auth" ? "Cancel authentication" : "Cancel live provider checks" }));
    await act(async () => {
      deletion.resolve();
      // Run the DELETE continuation, but keep React effects batched until
      // after the same-ID GET response has also been delivered.
      await Promise.resolve();
      poll.resolve(active);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: kind === "auth" ? "Cancel authentication" : "Cancel live provider checks" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run live checks for all displayed providers" })).toBeEnabled();
  });

  it("labels current config sources and saves only future-conversation defaults", async () => {
    const close = vi.fn();
    render(<AgentSettingsDialog open onClose={close} dialogRef={createRef<HTMLElement>()} />);

    expect(screen.getByRole("dialog", { name: "Alpha settings" })).toBeVisible();
    expect(screen.getByText(/Existing conversations and other channels are unchanged/u)).toBeVisible();
    expect(screen.getByText(/Any model mismatch or fallback appears on that run/u)).toBeVisible();
    expect(screen.queryByText("Effective model")).toBeNull();
    expect(screen.queryByText("Effective effort")).toBeNull();
    expect(screen.getByText(/Config default:/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose other model" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose high effort" }));
    const save = screen.getByRole("button", { name: "Save for new conversations" });
    expectDialogTypography(save, "12px");
    fireEvent.click(save);

    await vi.waitFor(() => {
      expect(storeMock.setAgentRunDefaults).toHaveBeenCalledWith("provider/other", "high");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("pins and unpins the selected agent from its header", () => {
    // `resetAllMocks` above strips the resolved value; the click awaits it.
    storeMock.setAgentPinned.mockResolvedValue(undefined);
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    const pin = screen.getByRole("button", { name: "Pin Alpha first" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(storeMock.setAgentPinned).toHaveBeenCalledWith("alpha", true);
  });

  it("makes the normal settings body the dialog scroll boundary", () => {
    const { container } = render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const dialog = container.querySelector(".agent-settings-dialog");
    const body = container.querySelector(".agent-settings-body");

    expect(dialog?.children[1]).toBe(body);
    expect(window.getComputedStyle(body!).overflowY).toBe("auto");
  });

  it("reverts an active override with one click", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      runSettings: {
        config: { model: "provider/model", effort: "low" },
        override: { model: "provider/other", effort: "high" },
        effective: {
          model: "provider/other",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Revert to config" }));

    await vi.waitFor(() => expect(storeMock.clearAgentRunDefaults).toHaveBeenCalledOnce());
  });

  it("renders compact provider status rows and clears a masked key before submitting it", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const missingStatus = {
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "missing", verification: "not_verified",
        methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true }],
      }],
    };
    apiMock.providerAuthStatus.mockResolvedValueOnce(missingStatus).mockResolvedValue({
      ...missingStatus,
      generatedAt: "2026-09-06T12:00:01.000Z",
      providers: [{ ...missingStatus.providers[0], state: "present", credentialType: "api_key", source: "stored" }],
    });
    const awaiting = {
      schema: "mono-agent.provider-auth-session.v1", id: "session-1", providerId: "opencode-go",
      authType: "api_key", strategy: "api_key_prompt", state: "awaiting_input",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      prompt: { id: "prompt-1", type: "secret", message: "Enter the OpenCode API key" },
    };
    apiMock.beginProviderAuth.mockResolvedValue(awaiting);
    apiMock.submitProviderAuth.mockImplementation(async () => {
      expect(screen.getByLabelText("Enter the OpenCode API key")).toHaveValue("");
      return { ...awaiting, state: "succeeded", prompt: undefined, updatedAt: "2026-09-06T12:00:01.000Z" };
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("Needs action")).toBeVisible();
    const providerName = screen.getByText("OpenCode Go");
    const providerState = screen.getByText("Needs action");
    expect(providerName).toBeVisible();
    expectDialogTypography(providerName, "12px");
    expectDialogTypography(providerState, "10px");
    expect(screen.queryByText("opencode-go")).not.toBeInTheDocument();
    expect(screen.queryByText(/Used by/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/No credential detected/u)).not.toBeInTheDocument();
    const authenticate = await screen.findByRole("button", { name: "Authenticate" });
    expectDialogTypography(authenticate, "12px");
    fireEvent.click(authenticate);
    const key = await screen.findByLabelText("Enter the OpenCode API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    fireEvent.change(key, { target: { value: "PROVIDER_AUTH_SECRET_SENTINEL" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));

    await vi.waitFor(() => expect(apiMock.submitProviderAuth).toHaveBeenCalledWith(
      "alpha", "session-1", { promptId: "prompt-1", value: "PROVIDER_AUTH_SECRET_SENTINEL" },
    ));
    expect(document.body.textContent).not.toContain("PROVIDER_AUTH_SECRET_SENTINEL");
    expect(await screen.findByRole("button", { name: "Close authentication" })).toBeVisible();
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(2));
    const notVerified = await screen.findByText("Not verified");
    expect(notVerified).toBeVisible();
    expectDialogTypography(notVerified, "10px");
  });

  it("polls an unchanged replacement to success and ignores the old poll when it completes late", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const method = { authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true } as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [method],
      }],
    });
    const active = {
      schema: "mono-agent.provider-auth-session.v1", id: "session-old", providerId: "opencode-go",
      authType: "api_key", strategy: "api_key_prompt", state: "awaiting_input",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      prompt: { id: "prompt-old", type: "secret", message: "Old API key prompt" },
    } as const;
    const replacement = {
      ...active,
      id: "session-new",
      state: "pending",
      updatedAt: "2026-09-06T12:00:02.000Z",
      prompt: undefined,
      progress: "Fresh authentication started",
    } as const;
    const replacementRequest = deferred<typeof replacement>();
    const oldPoll = deferred<Omit<typeof active, "state"> & {
      readonly state: "awaiting_input" | "succeeded";
      readonly progress?: string;
    }>();
    apiMock.beginProviderAuth.mockResolvedValueOnce(active).mockImplementationOnce(async () => await replacementRequest.promise);
    let replacementPolls = 0;
    apiMock.providerAuthSession.mockImplementation(async (_sourceId: string, sessionId: string) => {
      if (sessionId === active.id) return await oldPoll.promise;
      replacementPolls += 1;
      return replacementPolls < 3
        ? { ...replacement }
        : { ...replacement, state: "succeeded", updatedAt: "2026-09-06T12:00:05.000Z", progress: "FRESH SESSION SUCCEEDED" };
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    const authenticate = await screen.findByRole("button", { name: "Re-authenticate" });
    vi.useFakeTimers();
    fireEvent.click(authenticate);
    await act(async () => await Promise.resolve());
    expect(screen.getByLabelText("Old API key prompt")).toBeVisible();
    await advanceProviderPolls();
    expect(apiMock.providerAuthSession).toHaveBeenCalledWith("alpha", "session-old", expect.any(AbortSignal));
    const restart = screen.getByRole("button", { name: "Re-authenticate" });
    expect(restart).toBeEnabled();
    fireEvent.click(restart);
    expect(screen.getByLabelText("Old API key prompt")).toBeVisible();
    expect(screen.getByText("Restarting authentication…")).toHaveAttribute("aria-live", "polite");

    await act(async () => replacementRequest.resolve(replacement));
    expect(screen.getByText("Fresh authentication started")).toBeVisible();
    await advanceProviderPolls(3);
    expect(screen.getByText("FRESH SESSION SUCCEEDED")).toBeVisible();
    expect(apiMock.providerAuthSession.mock.calls.filter(([, sessionId]) => sessionId === replacement.id)).toHaveLength(3);
    await act(async () => oldPoll.resolve({ ...active, state: "succeeded", progress: "STALE OLD SESSION" }));
    expect(screen.queryByText("STALE OLD SESSION")).not.toBeInTheDocument();
    expect(screen.getByText("FRESH SESSION SUCCEEDED")).toBeVisible();
  }, 6_000);

  it("keeps the newest successful start when start responses settle out of order", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const method = { authType: "api_key", strategy: "api_key_prompt", label: "API key", recommended: true } as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: ["older", "newer"].map((providerId) => ({
        providerId, label: providerId === "older" ? "Older provider" : "Newer provider",
        usages: [{ kind: "primary", model: `${providerId}:model`, label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [method],
      })),
    });
    const older = deferred<Record<string, unknown>>();
    const newer = deferred<Record<string, unknown>>();
    apiMock.beginProviderAuth.mockImplementation(async (_source: string, providerId: string) =>
      await (providerId === "older" ? older.promise : newer.promise));
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const buttons = await screen.findAllByRole("button", { name: "Re-authenticate" });

    await act(async () => {
      buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(apiMock.beginProviderAuth).toHaveBeenCalledTimes(2);
    newer.resolve(sessionSnapshot("session-newer", "NEWER SESSION"));
    expect(await screen.findByText("NEWER SESSION")).toBeVisible();
    older.resolve(sessionSnapshot("session-older", "STALE OLDER SESSION"));
    await act(async () => await Promise.resolve());

    expect(screen.queryByText("STALE OLDER SESSION")).not.toBeInTheDocument();
    expect(screen.getByText("NEWER SESSION")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Re-authenticate" })[0]).toBeEnabled());

    const staleFailure = deferred<Record<string, unknown>>();
    const finalSuccess = deferred<Record<string, unknown>>();
    apiMock.beginProviderAuth.mockImplementation(async (_source: string, providerId: string) =>
      await (providerId === "older" ? staleFailure.promise : finalSuccess.promise));
    const retryButtons = screen.getAllByRole("button", { name: "Re-authenticate" });
    await act(async () => {
      retryButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retryButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    finalSuccess.resolve(sessionSnapshot("session-final", "FINAL SUCCESS"));
    expect(await screen.findByText("FINAL SUCCESS")).toBeVisible();
    staleFailure.reject(new Error("STALE START ERROR"));
    await act(async () => await Promise.resolve());
    expect(screen.queryByText("STALE START ERROR")).not.toBeInTheDocument();
    expect(screen.getByText("FINAL SUCCESS")).toBeVisible();
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Re-authenticate" })[0]).toBeEnabled());

    const validOlder = deferred<Record<string, unknown>>();
    const invalidNewer = deferred<Record<string, unknown>>();
    apiMock.beginProviderAuth.mockImplementation(async (_source: string, providerId: string) =>
      await (providerId === "older" ? validOlder.promise : invalidNewer.promise));
    const finalButtons = screen.getAllByRole("button", { name: "Re-authenticate" });
    await act(async () => {
      finalButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      finalButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    invalidNewer.reject(new Error("NEWER INVALID START"));
    expect(await screen.findByText("NEWER INVALID START")).toBeVisible();
    validOlder.resolve(sessionSnapshot("session-older-valid", "OLDER VALID SESSION"));

    expect(await screen.findByText("OLDER VALID SESSION")).toBeVisible();
    expect(screen.queryByText("NEWER INVALID START")).not.toBeInTheDocument();
  });

  it("does not let stale input or cancel completion overwrite a replacement session", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const method = { authType: "api_key", strategy: "api_key_prompt", label: "API key", recommended: true } as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:model", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [method],
      }],
    });
    const active = {
      ...sessionSnapshot("session-active", "ACTIVE SESSION"),
      providerId: "opencode-go",
      state: "awaiting_input",
      prompt: { id: "prompt-active", type: "secret", message: "Current API key" },
    } as const;
    const submitted = deferred<Record<string, unknown>>();
    const firstReplacement = deferred<ReturnType<typeof sessionSnapshot>>();
    const cancelled = deferred<void>();
    const secondReplacement = deferred<ReturnType<typeof sessionSnapshot>>();
    apiMock.beginProviderAuth
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(async () => await firstReplacement.promise)
      .mockImplementationOnce(async () => await secondReplacement.promise);
    apiMock.submitProviderAuth.mockImplementationOnce(async () => await submitted.promise);
    apiMock.cancelProviderAuth.mockImplementationOnce(async () => await cancelled.promise);
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }));
    const input = await screen.findByLabelText("Current API key");
    fireEvent.change(input, { target: { value: "fake-input" } });
    const submit = screen.getByRole("button", { name: "Submit once" });
    const restart = screen.getByRole("button", { name: "Re-authenticate" });
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      restart.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    firstReplacement.resolve({ ...sessionSnapshot("session-replacement", "REPLACEMENT ONE"), providerId: "opencode-go" });
    expect(await screen.findByText("REPLACEMENT ONE")).toBeVisible();
    submitted.resolve({ ...active, state: "succeeded", prompt: undefined, progress: "STALE SUBMIT" });
    await act(async () => await Promise.resolve());
    expect(screen.queryByText("STALE SUBMIT")).not.toBeInTheDocument();

    const cancel = screen.getByRole("button", { name: "Cancel authentication" });
    const restartAgain = screen.getByRole("button", { name: "Re-authenticate" });
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      restartAgain.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    secondReplacement.resolve({ ...sessionSnapshot("session-final", "FINAL SESSION"), providerId: "opencode-go" });
    expect(await screen.findByText("FINAL SESSION")).toBeVisible();
    cancelled.resolve();
    await act(async () => await Promise.resolve());
    expect(screen.queryByRole("button", { name: "Close authentication" })).not.toBeInTheDocument();
    expect(screen.getByText("FINAL SESSION")).toBeVisible();
  });

  it("uses status-only rows and limits actions to actionable providers", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [
        {
          providerId: "openai", label: "OpenAI", usages: [{ kind: "primary", model: "openai:gpt-5", label: "Primary model" }],
          state: "present", source: "environment", verification: "verified_by_live_request",
          methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenAI API key", recommended: true }],
        },
        {
          providerId: "copilot", label: "GitHub Copilot", usages: [{ kind: "fallback", model: "github-copilot:gpt-5", label: "Fallback model" }],
          state: "missing", verification: "not_verified",
          methods: [{ authType: "oauth", strategy: "device_code", label: "GitHub device code", recommended: true }],
        },
        {
          providerId: "local", label: "Local model", usages: [{ kind: "primary", model: "ollama:llama", label: "Primary model" }],
          state: "not_applicable", verification: "not_applicable", methods: [],
        },
      ],
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("OK")).toBeVisible();
    expect(screen.getByText("Needs action")).toBeVisible();
    expect(screen.getByText("Not applicable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Authenticate" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-authenticate" })).toBeVisible();
    expect(screen.queryByText("openai")).not.toBeInTheDocument();
    expect(screen.queryByText("environment")).not.toBeInTheDocument();
    expect(screen.queryByText(/Primary model/u)).not.toBeInTheDocument();
  });

  it("shows a recorded auth failure ahead of a not-applicable static state", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "keyless-fixture", label: "Keyless fixture",
        usages: [{ kind: "primary", model: "keyless-fixture:model", label: "Primary model" }],
        state: "not_applicable", verification: "not_applicable", methods: [],
        lastFailure: {
          kind: "provider_auth", message: "Provider rejected the configured credential.",
          model: "keyless-fixture:model", observedAt: "2026-09-06T11:59:00.000Z",
        },
      }],
    });

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("Needs action")).toBeVisible();
    expect(screen.queryByText("Not applicable")).not.toBeInTheDocument();
  });

  it("does not promote static presence to OK and runs one compact explicit batch", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      supportsProviderAuth: true,
      supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [
        {
          providerId: "opencode-go", label: "OpenCode Go",
          usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
          state: "present", source: "environment", verification: "not_verified",
          methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true }],
        },
        {
          providerId: "openai-codex", label: "OpenAI Codex",
          usages: [{ kind: "fallback", model: "openai-codex:gpt-5.6-sol", label: "Fallback model" }],
          state: "present", source: "stored", verification: "not_verified",
          methods: [{ authType: "oauth", strategy: "device_code", label: "OpenAI Codex", recommended: true }],
        },
      ],
    });
    apiMock.beginProviderAuthCheck.mockResolvedValue({
      schema: "mono-agent.provider-auth-check.v1",
      id: "check-one",
      state: "completed",
      createdAt: "2026-09-06T12:00:00.000Z",
      updatedAt: "2026-09-06T12:00:01.000Z",
      expiresAt: "2026-09-06T12:10:01.000Z",
      results: [
        {
          providerId: "opencode-go", label: "OpenCode Go", state: "passed",
          model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing",
          checkedAt: "2026-09-06T12:00:01.000Z", code: "passed", message: "Provider request succeeded.",
        },
        {
          providerId: "openai-codex", label: "OpenAI Codex", state: "auth_failed",
          model: "openai-codex:gpt-5.6-sol", selectionBasis: "subscription_zero_price",
          checkedAt: "2026-09-06T12:00:01.000Z", code: "credential_rejected", message: "Provider rejected the configured credential.",
        },
      ],
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect((await screen.findAllByText("Not verified"))).toHaveLength(2);
    expect(screen.queryByText("OK")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Re-authenticate" })).toHaveLength(2);
    const run = screen.getByRole("button", { name: "Run live checks for all displayed providers" });
    expect(run).toHaveTextContent("Run check");
    expectDialogTypography(run, "12px");
    expect(window.getComputedStyle(run).minHeight).toBe("38px");
    expect(run).toHaveClass("provider-auth-neutral-button");
    expect(screen.getByText(/may use quota or refresh OAuth/u)).toBeVisible();
    fireEvent.click(run);

    await vi.waitFor(() => expect(apiMock.beginProviderAuthCheck).toHaveBeenCalledWith("alpha", expect.any(String)));
    expect(await screen.findByText("Check passed")).toBeVisible();
    expect(screen.getByText("Auth failed")).toBeVisible();
    expect(screen.getByText("Checks complete: 1 of 2 passed.")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the post-auth status when an older completed-check refresh resolves late", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    const verified = providerAuthStatusSnapshot("verified_by_live_request");
    const notVerified = providerAuthStatusSnapshot("not_verified");
    const staleCheckRefresh = deferred<ReturnType<typeof providerAuthStatusSnapshot>>();
    apiMock.providerAuthStatus
      .mockResolvedValueOnce(verified)
      .mockImplementationOnce(async () => await staleCheckRefresh.promise)
      .mockResolvedValueOnce(notVerified);
    apiMock.beginProviderAuthCheck.mockResolvedValue(completedProviderAuthCheck());
    apiMock.beginProviderAuth.mockResolvedValue(successfulProviderAuthSession());

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    expect(await screen.findByText("OK")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run live checks for all displayed providers" }));
    expect(await screen.findByText("Check passed")).toBeVisible();
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Not verified")).toBeVisible();

    await act(async () => staleCheckRefresh.resolve(verified));
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.queryByText("OK")).not.toBeInTheDocument();
  });

  it("ignores an older completed-check refresh rejection after authentication", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    const staleCheckRefresh = deferred<ReturnType<typeof providerAuthStatusSnapshot>>();
    apiMock.providerAuthStatus
      .mockResolvedValueOnce(providerAuthStatusSnapshot("verified_by_live_request"))
      .mockImplementationOnce(async () => await staleCheckRefresh.promise)
      .mockResolvedValueOnce(providerAuthStatusSnapshot("not_verified"));
    apiMock.beginProviderAuthCheck.mockResolvedValue(completedProviderAuthCheck());
    apiMock.beginProviderAuth.mockResolvedValue(successfulProviderAuthSession());

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    expect(await screen.findByText("OK")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run live checks for all displayed providers" }));
    expect(await screen.findByText("Check passed")).toBeVisible();
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Not verified")).toBeVisible();

    await act(async () => staleCheckRefresh.reject(new Error("STALE CHECK REFRESH ERROR")));
    expect(screen.queryByText("STALE CHECK REFRESH ERROR")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a passed live-check result when valid re-authentication is adopted", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue(providerAuthStatusSnapshot("not_verified"));
    apiMock.beginProviderAuthCheck.mockResolvedValue(completedProviderAuthCheck());
    apiMock.beginProviderAuth.mockResolvedValue(successfulProviderAuthSession());

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    expect(await screen.findByText("Not verified")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run live checks for all displayed providers" }));
    expect(await screen.findByText("Check passed")).toBeVisible();
    expect(screen.getByText("Checks complete: 1 of 1 passed.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    expect(await screen.findByRole("button", { name: "Close authentication" })).toBeVisible();
    expect(screen.queryByText("Check passed")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks complete: 1 of 1 passed.")).not.toBeInTheDocument();
  });

  it("offers a normal-size neutral cancel control while checks are active", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      supportsProviderAuth: true,
      supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "environment", verification: "not_verified", methods: [],
      }],
    });
    apiMock.beginProviderAuthCheck.mockResolvedValue({
      schema: "mono-agent.provider-auth-check.v1",
      id: "check-running",
      state: "running",
      createdAt: "2026-09-06T12:00:00.000Z",
      updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{
        providerId: "opencode-go", label: "OpenCode Go", state: "running",
        model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing",
      }],
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(await findStartButton("Run live checks for all displayed providers"));
    const cancel = await screen.findByRole("button", { name: "Cancel live provider checks" });
    expect(cancel).toHaveTextContent("Cancel checks");
    expect(cancel).toHaveClass("provider-auth-neutral-button");
    expectDialogTypography(cancel, "12px");
    expect(window.getComputedStyle(cancel).minHeight).toBe("38px");
    fireEvent.click(cancel);
    await vi.waitFor(() => expect(apiMock.cancelProviderAuthCheck).toHaveBeenCalledWith("alpha", "check-running"));
    expect(await screen.findByText("Checks complete: 0 of 1 passed.")).toBeVisible();
  });

  it("keeps polling through unchanged running snapshots until the check completes", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      supportsProviderAuth: true,
      supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "environment", verification: "not_verified", methods: [],
      }],
    });
    const running = {
      schema: "mono-agent.provider-auth-check.v1", id: "check-recurring", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{
        providerId: "opencode-go", label: "OpenCode Go", state: "running",
        model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing",
      }],
    } as const;
    const completed = {
      ...running,
      state: "completed",
      updatedAt: "2026-09-06T12:00:03.000Z",
      results: [{
        ...running.results[0], state: "passed", checkedAt: "2026-09-06T12:00:03.000Z",
        code: "passed", message: "Provider request succeeded.",
      }],
    } as const;
    apiMock.beginProviderAuthCheck.mockResolvedValue(running);
    apiMock.providerAuthCheck
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running })
      .mockResolvedValueOnce(completed);

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const run = await findStartButton("Run live checks for all displayed providers");
    vi.useFakeTimers();
    fireEvent.click(run);
    await act(async () => await Promise.resolve());

    expect(screen.getByText("Checking…")).toBeVisible();
    await advanceProviderPolls(3);
    expect(apiMock.providerAuthCheck).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Check passed")).toBeVisible();
    expect(screen.getByText("Checks complete: 1 of 1 passed.")).toBeVisible();
  }, 6_000);

  it("ends a locally running check when its retained session has expired", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [],
      }],
    });
    const running = {
      schema: "mono-agent.provider-auth-check.v1", id: "expired-check", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{ providerId: "opencode-go", label: "OpenCode Go", state: "running", model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing" }],
    } as const;
    apiMock.beginProviderAuthCheck.mockResolvedValue(running);
    apiMock.providerAuthCheck.mockRejectedValue(Object.assign(new Error("expired"), {
      status: 404, code: "provider_auth_not_found",
    }));

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const run = await findStartButton("Run live checks for all displayed providers");
    vi.useFakeTimers();
    fireEvent.click(run);
    await act(async () => await Promise.resolve());
    expect(screen.getByRole("button", { name: "Cancel live provider checks" })).toBeVisible();
    await advanceProviderPolls();
    expect(screen.getByRole("button", { name: "Run live checks for all displayed providers" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(apiMock.providerAuthCheck).toHaveBeenCalledOnce();
    await advanceProviderPolls();
    expect(apiMock.providerAuthCheck).toHaveBeenCalledOnce();
  }, 4_000);

  it("recovers from cancelling a check that is already absent", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1", generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [],
      }],
    });
    apiMock.beginProviderAuthCheck.mockResolvedValue({
      schema: "mono-agent.provider-auth-check.v1", id: "already-absent", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{ providerId: "opencode-go", label: "OpenCode Go", state: "running", model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing" }],
    });
    apiMock.cancelProviderAuthCheck.mockRejectedValueOnce(Object.assign(new Error("already absent"), {
      status: 404, code: "provider_auth_not_found",
    }));

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    fireEvent.click(await findStartButton("Run live checks for all displayed providers"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel live provider checks" }));
    expect(await screen.findByRole("button", { name: "Run live checks for all displayed providers" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps polling a check after a transient read failure", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1", generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified", methods: [],
      }],
    });
    const running = {
      schema: "mono-agent.provider-auth-check.v1", id: "transient-check", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z", expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{ providerId: "opencode-go", label: "OpenCode Go", state: "running", model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing" }],
    } as const;
    apiMock.beginProviderAuthCheck.mockResolvedValue(running);
    apiMock.providerAuthCheck
      .mockRejectedValueOnce(new Error("temporary link failure"))
      .mockResolvedValueOnce({
        ...running, state: "completed", updatedAt: "2026-09-06T12:00:02.000Z",
        results: [{ ...running.results[0], state: "passed", checkedAt: "2026-09-06T12:00:02.000Z", code: "passed", message: "Provider request succeeded." }],
      });

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const run = await findStartButton("Run live checks for all displayed providers");
    vi.useFakeTimers();
    fireEvent.click(run);
    await act(async () => await Promise.resolve());
    await advanceProviderPolls(2);
    expect(screen.getByText("Check passed")).toBeVisible();
    expect(apiMock.providerAuthCheck).toHaveBeenCalledTimes(2);
  }, 4_000);

  it("closes a method chooser when a live check starts", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      supportsProviderAuth: true,
      supportsProviderAuthChecks: true,
    });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "anthropic", label: "Anthropic",
        usages: [{ kind: "primary", model: "anthropic:claude", label: "Primary model" }],
        state: "present", source: "stored", verification: "not_verified",
        methods: [
          { authType: "oauth", strategy: "paste_back", label: "Anthropic OAuth", recommended: true },
          { authType: "api_key", strategy: "api_key_prompt", label: "Anthropic API key", recommended: false },
        ],
      }],
    });
    apiMock.beginProviderAuthCheck.mockResolvedValue({
      schema: "mono-agent.provider-auth-check.v1", id: "check-methods", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{
        providerId: "anthropic", label: "Anthropic", state: "running",
        model: "anthropic:claude", selectionBasis: "subscription_zero_price",
      }],
    });

    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }));
    expect(screen.getByRole("button", { name: "Anthropic OAuth" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Anthropic API key" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run live checks for all displayed providers" }));

    expect(await screen.findByRole("button", { name: "Cancel live provider checks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Anthropic OAuth" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anthropic API key" })).not.toBeInTheDocument();
  });

  it("starts OpenAI device code directly and offers paste-back only after it is unavailable", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha", supportsProviderAuth: true, supportsProviderAuthChecks: true,
    });
    const methods = [
      { authType: "oauth", strategy: "device_code", label: "OpenAI Codex (device code)", recommended: true },
      { authType: "oauth", strategy: "paste_back", label: "OpenAI Codex (paste redirect)", recommended: false },
    ] as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "openai-codex", label: "OpenAI Codex",
        usages: [{ kind: "primary", model: "openai-codex:gpt-5.6-terra", label: "Primary model" }],
        state: "missing", verification: "not_verified", methods,
      }],
    });
    const failed = {
      schema: "mono-agent.provider-auth-session.v1", id: "session-openai", providerId: "openai-codex",
      authType: "oauth", strategy: "device_code", state: "failed",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:01.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      error: { code: "device_code_unavailable", message: "Device-code authentication is unavailable; retry with browser paste-back." },
    };
    apiMock.beginProviderAuth.mockResolvedValueOnce(failed).mockResolvedValueOnce({
      ...failed, id: "session-paste", strategy: "paste_back", state: "pending", error: undefined,
    });
    apiMock.beginProviderAuthCheck.mockResolvedValue({
      schema: "mono-agent.provider-auth-check.v1", id: "check-retry", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{
        providerId: "openai-codex", label: "OpenAI Codex", state: "running",
        model: "openai-codex:gpt-5.6-terra", selectionBasis: "subscription_zero_price",
      }],
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    await vi.waitFor(() => expect(apiMock.beginProviderAuth).toHaveBeenNthCalledWith(
      1, "alpha", "openai-codex", methods[0],
    ));
    const retry = await screen.findByRole("button", { name: "Retry with browser paste-back" });
    expect(screen.queryByText("Choose how to authenticate OpenAI Codex")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run live checks for all displayed providers" }));
    expect(await screen.findByRole("button", { name: "Cancel live provider checks" })).toBeVisible();
    expect(retry).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel live provider checks" }));
    await vi.waitFor(() => expect(apiMock.cancelProviderAuthCheck).toHaveBeenCalledWith("alpha", "check-retry"));
    await vi.waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await vi.waitFor(() => expect(apiMock.beginProviderAuth).toHaveBeenNthCalledWith(
      2, "alpha", "openai-codex", methods[1],
    ));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Cancel authentication" })).toBeEnabled());
  });

  it("renders paste-back instructions as a safe external link and cancels an active session on close", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const method = { authType: "oauth", strategy: "paste_back", label: "Anthropic OAuth", recommended: true } as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "anthropic", label: "Anthropic",
        usages: [{ kind: "primary", model: "anthropic:claude-sonnet-4-5", label: "Primary model" }],
        state: "expired", credentialType: "oauth", source: "stored", expiresAt: "2026-09-06T11:00:00.000Z",
        verification: "not_verified", methods: [method],
        lastFailure: { kind: "provider_auth", message: "Provider rejected the configured credential.", model: "anthropic:claude-sonnet-4-5", observedAt: "2026-09-06T11:30:00.000Z" },
      }],
    });
    apiMock.beginProviderAuth.mockResolvedValue({
      schema: "mono-agent.provider-auth-session.v1", id: "session-anthropic", providerId: "anthropic",
      authType: "oauth", strategy: "paste_back", state: "awaiting_input",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:01.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      authUrl: {
        url: "https://console.anthropic.com/oauth/authorize",
        instructions: "If localhost cannot load, copy the complete final URL and paste it here.",
      },
      prompt: { id: "prompt-anthropic", type: "manual_code", message: "Paste the redirect URL" },
    });
    const rendered = render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("Needs action")).toBeVisible();
    expect(screen.queryByText("expired")).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider rejected the configured credential/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    const link = await screen.findByRole("link", { name: "Open authentication page" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/copy the complete final URL/u)).toBeVisible();
    expect(link.closest(".provider-auth-flow")).toHaveAttribute("aria-live", "polite");
    rendered.unmount();
    await vi.waitFor(() => expect(apiMock.cancelProviderAuth).toHaveBeenCalledWith(
      "alpha", "session-anthropic", expect.any(AbortSignal),
    ));
  });

  it("keeps an unsupported provider-auth capability terse", () => {
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(screen.getByText("Not available on this agent.")).toBeVisible();
    expect(screen.queryByText(/does not expose the protected provider-authentication capability/u)).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionSnapshot(id: string, progress: string) {
  return {
    schema: "mono-agent.provider-auth-session.v1",
    id,
    providerId: id.includes("newer") ? "newer" : "older",
    authType: "api_key",
    strategy: "api_key_prompt",
    state: "pending",
    createdAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:01.000Z",
    expiresAt: "2026-09-06T12:20:00.000Z",
    progress,
  };
}

function providerAuthStatusSnapshot(verification: "not_verified" | "verified_by_live_request") {
  return {
    schema: "mono-agent.provider-auth.v1",
    generatedAt: verification === "not_verified"
      ? "2026-09-06T12:00:03.000Z"
      : "2026-09-06T12:00:01.000Z",
    providers: [{
      providerId: "opencode-go", label: "OpenCode Go",
      usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
      state: "present", source: "stored", verification,
      methods: [{
        authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true,
      }],
    }],
  } as const;
}

function completedProviderAuthCheck() {
  return {
    schema: "mono-agent.provider-auth-check.v1",
    id: "check-completed-before-auth",
    state: "completed",
    createdAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:01.000Z",
    expiresAt: "2026-09-06T12:10:01.000Z",
    results: [{
      providerId: "opencode-go", label: "OpenCode Go", state: "passed",
      model: "opencode-go:kimi-k2.6", selectionBasis: "catalog_pricing",
      checkedAt: "2026-09-06T12:00:01.000Z", code: "passed", message: "Provider request succeeded.",
    }],
  } as const;
}

function successfulProviderAuthSession() {
  return {
    schema: "mono-agent.provider-auth-session.v1",
    id: "session-new-credential",
    providerId: "opencode-go",
    authType: "api_key",
    strategy: "api_key_prompt",
    state: "succeeded",
    createdAt: "2026-09-06T12:00:02.000Z",
    updatedAt: "2026-09-06T12:00:03.000Z",
    expiresAt: "2026-09-06T12:20:00.000Z",
    progress: "NEW CREDENTIAL INSTALLED",
  } as const;
}
