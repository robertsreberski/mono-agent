import { useEffect, useRef, useState } from "react";
import type { WebUser } from "../../../src/auth-contracts.js";
import { api } from "../api";
import { accountError, useAuth } from "../auth";
import { useConsoleStore } from "../console-store";
import type { AgentSummary } from "../types";

export function AccountPanel({ onClose }: { readonly onClose: () => void }) {
  const { user, admin } = useAuth();
  const [tab, setTab] = useState<"profile" | "users">("profile");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="account-dialog" onCancel={onClose} aria-labelledby="account-title">
    <header><h2 id="account-title">{tab === "profile" ? "Your profile" : "User administration"}</h2><button onClick={onClose} aria-label="Close account">Close</button></header>
    <nav aria-label="Account sections"><button onClick={() => setTab("profile")} aria-pressed={tab === "profile"}>Profile</button>{admin && <button onClick={() => setTab("users")} aria-pressed={tab === "users"}>Users</button>}</nav>
    {user && (tab === "profile" ? <ProfileEditor key={user.id} user={user} /> : admin ? <UserAdministration /> : null)}
  </dialog>;
}

export function ProfileEditor({ user }: { readonly user: WebUser }) {
  const { logout, reauthenticate } = useAuth();
  const [name, setName] = useState(user.displayName);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (operation: () => Promise<void>) => {
    setError(null); setBusy(true);
    void operation().catch((failure: unknown) => setError(accountError(failure))).finally(() => setBusy(false));
  };
  return <section className="account-form">
    <p>Signed in as <strong>{user.username}</strong> · {user.role === "admin" ? "Administrator" : "User"}</p>
    <form onSubmit={(event) => { event.preventDefault(); submit(async () => { const result = await api.patchProfile(name); if (result.reauthenticate) reauthenticate(); }); }}>
      <label>Display name<input required maxLength={64} autoComplete="nickname" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p>Changing your name signs you out on every device.</p>
      <button disabled={busy || name === user.displayName}>Save display name</button>
    </form>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (password !== confirm) { setError("New passwords do not match."); return; }
      submit(async () => { await api.changePassword(current, password); setCurrent(""); setPassword(""); setConfirm(""); reauthenticate(); });
    }}>
      <h3>Change password</h3>
      <label>Current password<input required type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
      <label>New password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>Confirm new password<input required type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      <p>Use at least 12 characters. Changing your password signs you out on every device.</p>
      <button disabled={busy}>Change password</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => submit(logout)}>Log out</button>
  </section>;
}

export function UserAdministration() {
  const { agents } = useConsoleStore();
  const [users, setUsers] = useState<readonly WebUser[]>([]);
  const [editing, setEditing] = useState<WebUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const load = async () => {
    setLoading(true); setError(null);
    try { setUsers((await api.users()).users); setLoaded(true); } catch (failure) { setError(accountError(failure)); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return <section className="account-form">
    {error && <p role="alert">{error}<button onClick={() => void load()}>Retry users</button></p>}
    {loading && <p role="status">Loading users…</p>}
    {loaded && <>
      <div className="account-user-list"><button aria-pressed={editing === null} onClick={() => setEditing(null)}>Create user</button>{users.map((user) => <button key={user.id} aria-pressed={editing?.id === user.id} onClick={() => setEditing(user)}>{user.displayName} · {user.username}{user.disabled ? " · Disabled" : ""}</button>)}</div>
      <UserEditor key={editing?.id ?? "new"} user={editing} agents={agents} onSaved={async (user) => { await load(); setEditing(user); }} />
    </>}
  </section>;
}

export function UserEditor({ user, agents, onSaved }: { readonly user: WebUser | null; readonly agents: readonly AgentSummary[]; readonly onSaved: (user: WebUser) => Promise<void> }) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [name, setName] = useState(user?.displayName ?? "");
  const [role, setRole] = useState<"admin" | "user">(user?.role ?? "user");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [grants, setGrants] = useState<readonly string[]>(user?.grants ?? []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (operation: () => Promise<void>) => {
    setError(null); setNotice(null); setBusy(true);
    void operation().catch((failure: unknown) => setError(accountError(failure))).finally(() => setBusy(false));
  };
  return <section className="account-form">
    <h3>{user ? `Edit ${user.username}` : "Create user"}</h3>
    <form onSubmit={(event) => {
      event.preventDefault();
      submit(async () => {
        const result = user ? await api.patchUser(user.id, { displayName: name, role, disabled, grants }) : await api.createUser({ username, displayName: name, role, password, grants });
        setPassword(""); await onSaved(result.user); setNotice("User saved.");
      });
    }}>
      {!user && <label>Username<input required autoComplete="off" maxLength={64} value={username} onChange={(event) => setUsername(event.target.value)} /></label>}
      <label>Display name<input required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")}><option value="user">User</option><option value="admin">Administrator</option></select></label>
      {user && <label className="account-check"><input type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} />Disabled</label>}
      <fieldset><legend>Agent grants</legend><p>Administrators can use every agent. Grants control regular users’ access.</p>{agents.map((agent) => <label key={agent.sourceId} className="account-check"><input type="checkbox" checked={grants.includes(agent.sourceId)} onChange={(event) => setGrants(event.target.checked ? [...grants, agent.sourceId] : grants.filter((id) => id !== agent.sourceId))} />{agent.label}</label>)}</fieldset>
      {!user && <label>Initial password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
      <button disabled={busy}>{user ? "Save user" : "Create user"}</button>
    </form>
    {user && <form onSubmit={(event) => { event.preventDefault(); submit(async () => { await api.resetPassword(user.id, password); setPassword(""); setNotice("Password reset. This user must log in again."); }); }}>
      <label>Reset password<input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button disabled={busy}>Reset password</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
