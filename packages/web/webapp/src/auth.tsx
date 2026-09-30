import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { WebUser } from "../../src/auth-contracts.js";
import { api, ApiError } from "./api";
import { AUTH_INVALIDATED, AUTH_RECHECK, isMultiUser, setMultiUser } from "./auth-state";
import { resetComposerDraft } from "./composer-draft";
import { resetCronReplyRecoveryMemory } from "./cron-reply-recovery";
import { clearReplyImageBlobs } from "./components/reply-image-cache";
import { createThreadPersistence } from "./thread-persistence";

export const AUTH_CHANNEL = "mono-agent-web-auth";
const AUTH_SIGNAL_KEY = "mono-agent.web.auth-signal";
interface AuthContextValue {
  readonly multiUser: boolean;
  readonly user: WebUser | null;
  readonly admin: boolean;
  readonly logout: () => Promise<void>;
  readonly reauthenticate: () => void;
}
const AuthContext = createContext<AuthContextValue>({ multiUser: false, user: null, admin: true, logout: async () => {}, reauthenticate: () => {} });
export const useAuth = (): AuthContextValue => useContext(AuthContext);
export const accountError = (error: unknown): string => error instanceof ApiError
  ? `${error.message}${error.code ? ` (${error.code})` : ""}`
  : error instanceof Error ? error.message : "Account request failed.";

/** No console mounts until the origin's legacy data has been discarded. */
export async function clearAccountData(): Promise<void> {
  resetComposerDraft();
  resetCronReplyRecoveryMemory();
  clearReplyImageBlobs();
  for (const [store, keys] of [
    [localStorage, ["mono-agent.web.selected-agent", "mono-agent.web.selected-threads", "mono-agent.web.run-preferences", "mono-agent.web.pending-submissions", "mono-agent.web.notifications-enabled", "mono-agent.web.push-subscription-id", "mono-agent.web.push-endpoint-sha256", "mono-agent.web.push-pending-delete"]],
    [sessionStorage, ["mono-agent:web:cron-reply-recovery:v1"]],
  ] as const) {
    for (const key of keys) store.removeItem(key);
  }
  const persistence = createThreadPersistence();
  try { await persistence.clearAll(); } finally { persistence.close(); }
  // Only private runtime data, never the PWA shell/build cache.
  if (typeof caches !== "undefined") {
    for (const name of await caches.keys()) {
      if (name.includes("reply") || name.includes("attachment")) await caches.delete(name);
    }
  }
}

export function AuthGate({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<{ multiUser: boolean; user: WebUser | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const invalidate = useCallback(() => {
    generation.current += 1;
    setStatus((current) => current === null ? null : { ...current, user: null });
    setEpoch((value) => value + 1);
    resetComposerDraft();
    resetCronReplyRecoveryMemory();
    clearReplyImageBlobs();
  }, []);
  const broadcast = useCallback(() => {
    channel.current?.postMessage("invalidate");
    // storage event is the fallback for browsers without BroadcastChannel.
    try { localStorage.setItem(AUTH_SIGNAL_KEY, crypto.randomUUID()); } catch { /* memory-only browser */ }
  }, []);
  const reauthenticate = useCallback(() => { invalidate(); broadcast(); }, [broadcast, invalidate]);
  const resolve = useCallback(async () => {
    const issued = ++generation.current;
    setError(null);
    try {
      const next = await api.authStatus();
      if (issued !== generation.current) return;
      setMultiUser(next.multiUser);
      if (next.multiUser) await clearAccountData();
      if (issued !== generation.current) return;
      setEpoch((value) => value + 1);
      setStatus(next);
    } catch (failure) {
      if (issued === generation.current) setError(accountError(failure));
    }
  }, []);
  useEffect(() => {
    const expired = () => reauthenticate();
    // A dropped SSE stream can mean a changed account/grant or expired cookie.
    // Unmount first; do not leave a revoked transcript visible during recheck.
    const recheck = () => { invalidate(); setStatus(null); void resolve(); };
    const storage = (event: StorageEvent) => { if (event.key === AUTH_SIGNAL_KEY) recheck(); };
    const offline = () => {
      if (!isMultiUser()) return;
      invalidate(); setStatus(null); setError("Connect to the console to continue. Offline transcripts are unavailable in multi-user mode.");
    };
    const online = () => { if (isMultiUser()) recheck(); };
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(AUTH_CHANNEL);
      channel.current.onmessage = recheck;
    }
    window.addEventListener(AUTH_INVALIDATED, expired);
    window.addEventListener(AUTH_RECHECK, recheck);
    window.addEventListener("storage", storage);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void resolve();
    return () => {
      generation.current += 1;
      channel.current?.close();
      channel.current = null;
      window.removeEventListener(AUTH_INVALIDATED, expired);
      window.removeEventListener(AUTH_RECHECK, recheck);
      window.removeEventListener("storage", storage);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [invalidate, reauthenticate, resolve]);
  const logout = async () => {
    await api.logout();
    reauthenticate();
  };
  if (status === null) return <main className="account-gate"><section className="account-panel" aria-label="Console authentication">
    {error ? <><p role="alert">{error}</p><button onClick={() => void resolve()}>Retry</button></> : <p role="status">Checking console access…</p>}
  </section></main>;
  if (status.multiUser && status.user === null) return <LoginPanel onLogin={() => { broadcast(); void resolve(); }} />;
  return <AuthContext.Provider key={epoch} value={{ ...status, admin: !status.multiUser || status.user?.role === "admin", logout, reauthenticate }}>
    {children}
  </AuthContext.Provider>;
}

export function LoginPanel({ onLogin }: { readonly onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <main className="account-gate"><section className="account-panel" aria-labelledby="login-title">
    <span className="eyebrow">Mono Agent · Console</span>
    <h1 id="login-title">Log in</h1>
    <p>Your conversations are private unless you share them.</p>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError(null);
      void api.login(username, password).then(() => { setPassword(""); onLogin(); }, (failure: unknown) => setError(accountError(failure))).finally(() => setBusy(false));
    }}>
      <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
    </form>
    <p className="account-help">Ask your administrator for an account. Initial administrators are created with the offline CLI.</p>
  </section></main>;
}
