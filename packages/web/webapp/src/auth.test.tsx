import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AuthGate, useAuth } from "./auth";
import { isMultiUser, recheckAuthentication, setMultiUser } from "./auth-state";
import { ProfileEditor, UserEditor } from "./components/AccountPanel";
import { NotificationBell, NotificationsProvider } from "./notifications";
import { flushComposerDrafts, readComposerDraft, resetComposerDraft, writeComposerDraft } from "./composer-draft";
import { readSubmissionRecoveryReferences, rememberSubmissionRecoveryReference } from "./submission-recovery";
import { agent } from "./test/fixtures";
import type { WebUser } from "../../src/auth-contracts";

const user: WebUser = { id: "riley", username: "riley", displayName: "Riley", role: "admin", disabled: false, version: 1, grants: ["alpha"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
function ConsoleProbe() {
  const auth = useAuth();
  return <><p>Private console for {auth.user?.displayName ?? "legacy"}</p><button onClick={() => void auth.logout()}>Log out</button></>;
}
class Channel {
  static instances: Channel[] = [];
  onmessage: (() => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor() { Channel.instances.push(this); }
}

beforeEach(() => {
  setMultiUser(false); resetComposerDraft(); localStorage.clear(); sessionStorage.clear();
  Channel.instances = []; fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("BroadcastChannel", Channel);
});
afterEach(() => { cleanup(); resetComposerDraft(); setMultiUser(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("authentication boundary", () => {
  it("resolves legacy mode before mounting but preserves no-login behavior", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    expect(screen.queryByText(/Private console/)).toBeNull();
    resolve(json({ multiUser: false, user: null }));
    expect(await screen.findByText("Private console for legacy")).toBeVisible();
    expect(isMultiUser()).toBe(false);
    expect(screen.queryByRole("heading", { name: "Log in" })).toBeNull();
  });
  it("gates private children, surfaces login errors, and logs in without persisting a password", async () => {
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user: null }))
      .mockResolvedValueOnce(json({ error: { code: "invalid_credentials", message: "Invalid credentials." } }, 401))
      .mockResolvedValueOnce(json({ user }))
      .mockResolvedValueOnce(json({ multiUser: true, user }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeVisible();
    expect(screen.queryByText(/Private console/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "riley" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fictional-passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_credentials");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Private console for Riley")).toBeVisible();
    expect(JSON.stringify(localStorage)).not.toContain("fictional-passphrase");
  });
  it("clears legacy drafts and recovery references before mounting an authenticated console", async () => {
    writeComposerDraft("alpha", "old", "Old fictional draft"); flushComposerDrafts();
    rememberSubmissionRecoveryReference(localStorage, { threadId: "old", submissionId: "11111111-1111-4111-8111-111111111111" });
    fetchMock.mockResolvedValue(json({ multiUser: true, user }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    await screen.findByText("Private console for Riley");
    expect(readComposerDraft("alpha", "old")).toBe("");
    expect(readSubmissionRecoveryReferences(localStorage)).toEqual([]);
    writeComposerDraft("alpha", "new", "Memory-only draft"); flushComposerDrafts();
    expect(localStorage.getItem("mono-agent.web.composer-drafts")).toBeNull();
  });
  it("returns to login on an API 401 and resets mounted state", async () => {
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    await screen.findByText("Private console for Riley");
    fetchMock.mockResolvedValueOnce(json({ error: "Session expired" }, 401));
    await expect(api.profile()).rejects.toThrow("Session expired");
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeVisible();
    expect(screen.queryByText(/Private console/)).toBeNull();
    expect(Channel.instances[0]?.postMessage).toHaveBeenCalledWith("invalidate");
  });
  it("propagates logout and reacts to another tab and SSE revocation", async () => {
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    await screen.findByText("Private console for Riley");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("heading", { name: "Log in" });
    expect(Channel.instances[0]?.postMessage).toHaveBeenCalledWith("invalidate");
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user }));
    Channel.instances[0]?.onmessage?.();
    await screen.findByText("Private console for Riley");
    writeComposerDraft("alpha", "old", "Draft from Riley");
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user: null }));
    recheckAuthentication();
    await screen.findByRole("heading", { name: "Log in" });
    expect(readComposerDraft("alpha", "old")).toBe("");
  });
  it("drops private content while offline and resolves access again on reconnect", async () => {
    fetchMock.mockImplementation(async () => json({ multiUser: true, user }));
    render(<AuthGate><ConsoleProbe /></AuthGate>);
    await screen.findByText("Private console for Riley");
    window.dispatchEvent(new Event("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline transcripts are unavailable");
    expect(screen.queryByText(/Private console/)).toBeNull();
    window.dispatchEvent(new Event("online"));
    await screen.findByText("Private console for Riley");
  });
  it("suppresses notifications without mounting their store-dependent owner", () => {
    setMultiUser(true);
    render(<NotificationsProvider><p>Console</p><NotificationBell /></NotificationsProvider>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("account forms", () => {
  it("submits display-name changes then reauthenticates", async () => {
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user })).mockResolvedValueOnce(json({ user: { ...user, displayName: "Morgan" }, reauthenticate: true }));
    render(<AuthGate><ProfileEditor user={user} /></AuthGate>);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Morgan" } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await screen.findByRole("heading", { name: "Log in" });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ displayName: "Morgan" }));
  });
  it("requires password confirmation and sends current/new passwords only", async () => {
    fetchMock.mockResolvedValueOnce(json({ multiUser: true, user })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<AuthGate><ProfileEditor user={user} /></AuthGate>);
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "old-fictional-pass" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-fictional-pass" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "not-matching" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-fictional-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("heading", { name: "Log in" });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ currentPassword: "old-fictional-pass", password: "new-fictional-pass" }));
  });
  it("creates users with discovered agent checkbox grants and surfaces server errors", async () => {
    const saved = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce(json({ error: { code: "last_active_admin", message: "Keep an active administrator." } }, 409)).mockResolvedValueOnce(json({ user: { ...user, role: "user" } }));
    render(<UserEditor user={null} agents={[agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })]} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "morgan" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Morgan" } });
    fireEvent.change(screen.getByLabelText("Initial password"), { target: { value: "fictional-passphrase" } });
    fireEvent.click(screen.getByLabelText("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("last_active_admin");
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ username: "morgan", displayName: "Morgan", role: "user", grants: ["alpha"], password: "fictional-passphrase" });
  });
  it("edits roles/disabled/grants and resets passwords", async () => {
    const saved = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce(json({ user })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<UserEditor user={user} agents={[agent("alpha")]} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "user" } });
    fireEvent.click(screen.getByLabelText("Disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save user" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ displayName: "Riley", role: "user", disabled: true, grants: ["alpha"] });
    fireEvent.change(screen.getByLabelText("Reset password"), { target: { value: "fictional-reset-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Password reset");
  });
});
