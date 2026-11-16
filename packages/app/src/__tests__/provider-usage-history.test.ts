import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ProviderUsage, type ProviderUsageHistoryQuery, type ProviderUsageId } from "@mono-agent/contracts";
import { openOwnedState } from "../durable-state/owned-state-sqlite.js";
import { createProviderUsageHistoryStore } from "../providers/provider-usage-history.js";
import { createProviderUsageService } from "../providers/provider-usage.js";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const DAY = 86_400_000;
const q: ProviderUsageHistoryQuery = { from: "2026-10-24T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", bucket: "day", timeZone: "Europe/Berlin" };
const stores: ReturnType<typeof createProviderUsageHistoryStore>[] = [];
const roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() {
  const cache = new URL("../../node_modules/.cache/", import.meta.url).pathname;
  await mkdir(cache, { recursive: true });
  const path = await mkdtemp(join(cache, "quota-history-")); roots.push(path); return path;
}
function store(cwd: string, now = () => NOW) { const s = createProviderUsageHistoryStore({ cwd, now }); stores.push(s); return s; }
function usage(at = NOW, usedPercent = 20): ProviderUsage {
  return { providerId: "anthropic", label: "Claude", fetchedAt: new Date(at).toISOString(), stale: false,
    windows: [{ kind: "session", label: "Session", usedPercent, periodMs: 18_000_000, resetsAt: "2026-10-25T15:00:00.000Z" }] };
}
const retained = () => true;
const dbPath = (cwd: string) => join(cwd, ".mono-agent/provider-usage-v1/state.sqlite");
function count(cwd: string) { const db = new DatabaseSync(dbPath(cwd)); try { return (db.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number }).n; } finally { db.close(); } }

describe("owner-private quota history", () => {
  it("does not create storage on a history read; persists compressed observations across restart", async () => {
    const cwd = await root(); const s = store(cwd), sink = s.forScope("fictional/auth.json");
    expect((await sink.read(q, ["anthropic"])).providers[0]?.samples).toEqual([]);
    await expect(readFile(dbPath(cwd))).rejects.toMatchObject({ code: "ENOENT" });
    await sink.append(usage(), undefined, retained);
    await sink.append(usage(NOW + 300_000), undefined, retained);
    expect(count(cwd)).toBe(1);
    await s.close();
    const history = await store(cwd).forScope("fictional/auth.json").read(q, ["anthropic"]);
    expect(history.storage).toBe("ready");
    expect(history.timeZone).toBe("Europe/Berlin");
    expect(history.providers[0]?.samples).toHaveLength(2); // actual first/last endpoints, not interpolation
    expect(history.providers[0]?.samples[0]).toMatchObject({ observations: 2, maxGapMs: 300_000 });
  });
  it("does not lose a retained fetch when a no-create read owns the initialization flight", async () => {
    const cwd = await root(), s = store(cwd), sink = s.forScope("auth");
    await Promise.all([sink.read(q, ["anthropic"]), sink.append(usage(), undefined, retained)]);
    expect(count(cwd)).toBe(1);
  });
  it("keeps reset/plan changes, reversions and independent auth scopes", async () => {
    const cwd = await root(); const s = store(cwd), sink = s.forScope("first");
    await sink.append(usage(), undefined, retained);
    await sink.append(usage(NOW + 1, 30), undefined, retained);
    await sink.append(usage(NOW + 2), undefined, retained);
    await sink.append({ ...usage(NOW + 3), windows: [{ ...usage().windows[0]!, resetsAt: "2026-10-25T20:00:00.000Z" }] }, undefined, retained);
    await s.forScope("second").append(usage(NOW + 4, 75), undefined, retained);
    expect(count(cwd)).toBe(5);
    expect((await sink.read(q, ["anthropic"])).providers[0]?.samples.map(p => p.windows[0]?.usedPercent)).toEqual([20, 30, 20, 20]);
    await sink.clear(["anthropic"]);
    expect((await sink.read(q, ["anthropic"])).providers[0]?.samples).toEqual([]);
    expect((await s.forScope("second").read(q, ["anthropic"])).providers[0]?.samples[0]?.windows[0]?.usedPercent).toBe(75);
  });
  it("records account boundaries but exposes neither material nor keyed fingerprints", async () => {
    const cwd = await root(); const s = store(cwd), sink = s.forScope("fictional-private-path");
    await sink.append(usage(), "fictional-account-A", retained);
    await sink.append(usage(NOW + 1), "fictional-account-B", retained);
    const history = await sink.read(q, ["anthropic"]);
    expect(history.providers[0]?.accountChanges).toEqual([new Date(NOW + 1).toISOString()]);
    expect(history.providers[0]?.samples).toHaveLength(2);
    expect(JSON.stringify(history)).not.toMatch(/fingerprint|fictional-private|fictional-account|[a-f0-9]{64}/);
    await s.close();
    const bytes = await readFile(dbPath(cwd));
    expect(bytes.toString("utf8")).not.toMatch(/fictional-account|fictional-private/);
  });
  it("enforces retention even when no writes occurred after an idle restart", async () => {
    const cwd = await root(); let now = NOW; const s = store(cwd, () => now), sink = s.forScope("auth");
    await sink.append(usage(NOW - 89 * DAY), undefined, retained);
    now += 2 * DAY;
    const range = { ...q, from: new Date(now - 90 * DAY).toISOString(), to: new Date(now).toISOString() };
    await s.close();
    const fresh = store(cwd, () => now).forScope("auth");
    expect((await fresh.read(range, ["anthropic"])).providers[0]?.samples).toEqual([]);
    expect(count(cwd)).toBe(0);
    const inspected = new DatabaseSync(dbPath(cwd));
    expect(inspected.prepare("SELECT COUNT(*) AS n FROM partitions").get()).toMatchObject({ n: 0 });
    inspected.close();
    await fresh.append(usage(now), undefined, retained);
    expect(count(cwd)).toBe(1);
    const db = new DatabaseSync(dbPath(cwd));
    expect((db.prepare("PRAGMA max_page_count").get() as { max_page_count: number }).max_page_count).toBeGreaterThan(0);
    db.close();
  });
  it("bounds credential-scope churn and never samples rejected/stale/stopped values", async () => {
    const cwd = await root(); const s = store(cwd);
    for (let i = 0; i < 70; i++) await s.forScope(`fictional-scope-${i}`).append(usage(NOW + i), undefined, retained);
    expect(count(cwd)).toBe(64);
    const sink = s.forScope("last");
    await sink.append({ ...usage(), stale: true }, undefined, retained);
    await sink.append(usage(), undefined, () => false);
    expect(count(cwd)).toBe(64);
    await s.close(); await sink.append(usage(), undefined, retained);
    expect(count(cwd)).toBe(64);
  });
  it("evicts oldest changes at the row cap, but does not evict on an unchanged observation", async () => {
    const cwd = await root(), s = createProviderUsageHistoryStore({ cwd, now: () => NOW, maxSamples: 2 }); stores.push(s);
    const sink = s.forScope("auth");
    await sink.append(usage(NOW, 10), undefined, retained);
    await sink.append(usage(NOW + 1, 20), undefined, retained);
    await sink.append(usage(NOW + 2, 20), undefined, retained);
    expect(count(cwd)).toBe(2);
    await sink.append(usage(NOW + 3, 30), undefined, retained);
    const h = await sink.read(q, ["anthropic"]);
    expect(count(cwd)).toBe(2); expect(h.providers[0]?.truncatedBefore).toBe(new Date(NOW).toISOString());
    expect(h.providers[0]?.samples.map(p => p.windows[0]?.usedPercent)).toEqual([20, 30]);
    expect(h.providers[0]?.samples[0]?.observations).toBe(2); expect(h.providers[0]?.downsampled).toBe(true);
  });
  it("bounds the physical database and reports SQLITE_FULL without destroying committed history", async () => {
    const cwd = await root(), s = createProviderUsageHistoryStore({ cwd, now: () => NOW, maxDatabaseBytes: 64 * 1024 }); stores.push(s);
    const sink = s.forScope("auth");
    for (let i = 0; i < 400; i++) await sink.append(usage(NOW + i, i % 100), undefined, retained);
    expect((await sink.read(q, ["anthropic"])).storage).toBe("unavailable");
    expect((await stat(dbPath(cwd))).size).toBeLessThanOrEqual(64 * 1024);
    expect(count(cwd)).toBeGreaterThan(0);
    await sink.clear(["anthropic"]);
    expect((await sink.read(q, ["anthropic"])).storage).toBe("ready");
  });
  it("bounds stalled initialization and closes before a late initializer can write", async () => {
    const cwd = await root();
    let started!: () => void, release!: () => void, settled = false;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const s = createProviderUsageHistoryStore({ cwd, timeoutMs: 1000, closeTimeoutMs: 30,
      open: async options => {
        started(); await gate;
        try { return await openOwnedState(options); } finally { settled = true; }
      },
    }); stores.push(s);
    const pending = s.forScope("auth").append(usage(), undefined, retained);
    await began;
    await s.close(); // Must not await the stalled filesystem/open promise.
    release(); await pending;
    await vi.waitFor(() => expect(settled).toBe(true));
    await expect(readFile(dbPath(cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rolls back a process killed mid-write and reopens the committed samples", async () => {
    const cwd = await root(); const s = store(cwd);
    await s.forScope("auth").append(usage(), undefined, retained); await s.close();
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN IMMEDIATE; UPDATE samples SET payload='broken';");
      process.kill(process.pid, 'SIGKILL');
    `, dbPath(cwd)], { stdio: "pipe" })).toThrow();
    const history = await store(cwd).forScope("auth").read(q, ["anthropic"]);
    expect(history.storage).toBe("ready"); expect(history.providers[0]?.samples[0]?.windows[0]?.usedPercent).toBe(20);
  });
  it("refuses a second process writer lease without damaging the first writer", async () => {
    const cwd = await root(); const s = store(cwd);
    await s.forScope("auth").append(usage(), undefined, retained);
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1], { timeout: 0 });
        try { db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE'); process.exit(1); } catch { process.exit(42); }
      `, join(cwd, ".mono-agent/provider-usage-v1/lease.sqlite")], { stdio: "pipe" });
      throw new Error("A second writer unexpectedly acquired the lease.");
    } catch (error) { expect(error).toMatchObject({ status: 42 }); }
    const second = store(cwd); expect((await second.forScope("auth").read(q, ["anthropic"])).storage).toBe("unavailable");
    await s.forScope("auth").append(usage(NOW + 1, 40), undefined, retained); expect(count(cwd)).toBe(2);
  });
  it("releases the writer lease when domain metadata is malformed", async () => {
    const cwd = await root(), s = store(cwd); await s.forScope("auth").append(usage(), undefined, retained); await s.close();
    let db = new DatabaseSync(dbPath(cwd)); db.exec("ALTER TABLE meta RENAME TO broken_meta"); db.close();
    const reader = store(cwd);
    expect((await reader.forScope("auth").read(q, ["anthropic"])).storage).toBe("unavailable");
    // Repair the fictional fixture, then open another writer without closing reader:
    // the rejected domain open must already have released its exclusive lease.
    db = new DatabaseSync(dbPath(cwd)); db.exec("ALTER TABLE broken_meta RENAME TO meta"); db.close();
    expect((await store(cwd).forScope("auth").read(q, ["anthropic"])).storage).toBe("ready");
  });
  it.each(["corrupt", "future", "permissions", "hardlink", "symlink"])("fails closed on %s storage without repairing it", async kind => {
    const cwd = await root(); const s = store(cwd); await s.forScope("auth").append(usage(), undefined, retained); await s.close();
    if (kind === "corrupt") await writeFile(dbPath(cwd), "fictional corrupt database");
    if (kind === "future") { const db = new DatabaseSync(dbPath(cwd)); db.exec("PRAGMA user_version=99"); db.close(); }
    if (kind === "permissions") await chmod(dbPath(cwd), 0o644);
    if (kind === "symlink") { await rename(dbPath(cwd), join(cwd, "other.sqlite")); await symlink(join(cwd, "other.sqlite"), dbPath(cwd)); }
    if (kind === "hardlink") await link(dbPath(cwd), join(cwd, "other.sqlite"));
    const before = await readFile(dbPath(cwd));
    expect((await store(cwd).forScope("auth").read(q, ["anthropic"])).storage).toBe("unavailable");
    expect(await readFile(dbPath(cwd))).toEqual(before);
  });
});

describe("retained vendor fetch sampling", () => {
  async function fixture(provider: ProviderUsageId) {
    const cwd = await root(); let time = NOW;
    let credential: Record<string, unknown> | undefined = provider === "opencode-go" ? { type: "api_key", key: "fictional-key-A" }
      : { type: "oauth", access: "fictional-access-A", refresh: "fictional-refresh-A", expires: NOW + DAY, accountId: "fictional-account-A" };
    const resolver = Object.assign(vi.fn(async () => "fictional-access-B"), { readCredential: vi.fn(async (id: string) => id === provider ? credential : undefined) });
    const request = vi.fn(async () => Response.json({ five_hour: { utilization: 20 }, rate_limit: { primary_window: { used_percent: 20 } }, usage: { rolling: { percent: 20 } }, quota_snapshots: { premium_interactions: { percent_remaining: 80 } } }));
    const owner = store(cwd, () => time), sink = owner.forScope("auth");
    const append = vi.fn(sink.append);
    const service = createProviderUsageService({ resolver: resolver as never, fetch: request, copilotCredential: async () => undefined, now: () => time, history: { ...sink, append } });
    return { service, sink, append, request, credential: () => credential, replace: (c: typeof credential) => { credential = c; }, tick: () => { time += 300_000; }, cwd };
  }
  it.each(["anthropic", "openai-codex", "github-copilot", "opencode-go"] as const)("%s keeps history through access refresh and marks only detectable account changes", async provider => {
    const f = await fixture(provider);
    try {
      await f.service.snapshot(provider);
      await f.service.history!({ ...q, provider });
      await f.service.snapshot(provider); expect(f.append).toHaveBeenCalledTimes(1);
      f.replace({ ...f.credential(), access: "fictional-access-B", expires: NOW + 2 * DAY });
      await f.service.refresh(provider);
      expect((await f.service.history!({ ...q, provider })).providers[0]?.accountChanges).toEqual([]);
      f.tick();
      const change = provider === "github-copilot" ? { refresh: "fictional-refresh-B" } : provider === "opencode-go" ? { key: "fictional-key-B" } : { accountId: "fictional-account-B", refresh: "fictional-refresh-B" };
      f.replace({ ...f.credential(), ...change });
      await f.service.refresh(provider);
      const h = await f.service.history!({ ...q, provider });
      expect(h.providers[0]?.accountChanges).toHaveLength(provider === "anthropic" ? 0 : 1);
      f.replace(undefined); // Historical observations remain readable after sign-out.
      expect((await f.service.history!({ ...q, provider })).providers[0]?.samples.length).toBeGreaterThan(0);
      expect(f.append).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(h)).not.toMatch(/fictional-(access|refresh|account|key)|fingerprint/);
      expect((await readFile(dbPath(f.cwd))).toString("utf8")).not.toMatch(/fictional-(access|refresh|account|key)/);
    } finally { f.service.stop(); }
  });
  it("records one sample for concurrent callers sharing the same real fetch", async () => {
    const f = await fixture("anthropic");
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.request.mockImplementationOnce(async () => { started(); await gate; return Response.json({ five_hour: { utilization: 20 } }); });
    try {
      const first = f.service.refresh("anthropic"); await began;
      const second = f.service.refresh("anthropic"); release();
      await Promise.all([first, second]);
      await f.service.history!({ ...q, provider: "anthropic" });
      expect(f.request).toHaveBeenCalledTimes(1); expect(f.append).toHaveBeenCalledTimes(1); expect(count(f.cwd)).toBe(1);
    } finally { release(); f.service.stop(); }
  });
  it("never writes a discarded credential-race result, failed fetch or cache/backoff read", async () => {
    const f = await fixture("anthropic");
    try {
      f.request.mockImplementationOnce(async () => { f.replace({ ...f.credential(), access: "fictional-replaced" }); return Response.json({ five_hour: { utilization: 90 } }); });
      expect((await f.service.snapshot("anthropic")).providers).toEqual([]); expect(f.append).not.toHaveBeenCalled();
      f.request.mockImplementationOnce(async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
      await f.service.refresh("anthropic"); await f.service.refresh("anthropic"); await f.service.snapshot("anthropic");
      expect(f.append).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledTimes(2);
    } finally { f.service.stop(); }
  });
  it.each(["remove", "replace", "stop"] as const)("publishes before persistence, and preserves the %s fence while a prior append is pending", async mutation => {
    let credential: Record<string, unknown> | undefined = { type: "oauth", access: "fictional-A", accountId: "fictional-account-A", expires: NOW + DAY };
    let releaseFetch!: () => void;
    const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
    const append = vi.fn(async (_usage: ProviderUsage, _account?: string) => new Promise<void>(() => undefined));
    let calls = 0;
    const service = createProviderUsageService({ now: () => NOW, historyTimeoutMs: 1000,
      resolver: Object.assign(vi.fn(), { readCredential: async (id: string) => id === "openai-codex" ? credential : undefined }) as never,
      fetch: async () => { if (++calls === 2) await gate; return Response.json({ rate_limit: { primary_window: { used_percent: 30 } } }); },
      history: { append, read: async query => ({ schema: "mono-agent.provider-usage-history.v1", ...query, retentionDays: 90, storage: "ready", providers: [] }), clear: vi.fn() },
    });
    try {
      const first = await service.refresh("openai-codex");
      expect(first.providers[0]?.windows[0]?.usedPercent).toBe(30);
      expect(append).not.toHaveBeenCalled(); // publication precedes the persistence event-loop turn
      await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
      const pending = service.refresh("openai-codex");
      await vi.waitFor(() => expect(calls).toBe(2));
      if (mutation === "stop") await service.stop();
      else credential = mutation === "remove" ? undefined : { ...credential, access: "fictional-B", accountId: "fictional-account-B" };
      releaseFetch();
      expect((await pending).providers).toEqual([]);
      expect(append.mock.calls[0]?.[1]).toContain("fictional-account-A");
      expect(append.mock.calls[0]?.[1]).not.toContain("fictional-account-B");
      if (mutation === "remove" || mutation === "stop") expect((await service.snapshot("openai-codex")).providers).toEqual([]);
    } finally { releaseFetch(); await service.stop(); }
  });
  it("a never-settling append cannot strand snapshot/cache reads or teardown", async () => {
    const append = vi.fn(async (_usage: ProviderUsage, _account?: string) => new Promise<void>(() => undefined));
    const service = createProviderUsageService({ now: () => NOW, historyTimeoutMs: 300,
      resolver: Object.assign(vi.fn(), { readCredential: async () => ({ type: "oauth", access: "fictional-token", expires: NOW + DAY }) }) as never,
      fetch: async () => Response.json({ five_hour: { utilization: 20 } }),
      history: { append, read: async query => ({ schema: "mono-agent.provider-usage-history.v1", ...query, retentionDays: 90, storage: "ready", providers: [] }), clear: vi.fn() },
    });
    try {
      expect((await service.snapshot("anthropic")).providers).toHaveLength(1);
      expect((await service.snapshot("anthropic")).providers).toHaveLength(1);
      expect((await service.history!({ ...q, provider: "anthropic" })).storage).toBe("unavailable");
      await service.stop();
    } finally { await service.stop(); }
  });
  it("persists the captured fetched account even if credentials change while initialization waits", async () => {
    const cwd = await root(); let time = NOW;
    let accountId = "fictional-A", release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { entered = resolve; });
    const owner = createProviderUsageHistoryStore({ cwd, now: () => time, open: async options => {
      entered(); await gate; return openOwnedState(options);
    } }); stores.push(owner);
    const service = createProviderUsageService({ now: () => time,
      resolver: Object.assign(vi.fn(), { readCredential: async (id: string) => id === "openai-codex" ? {
        type: "oauth", access: "fictional-token", accountId, expires: NOW + DAY,
      } : undefined }) as never,
      history: owner.forScope("auth"), fetch: async () => Response.json({ rate_limit: { primary_window: { used_percent: accountId === "fictional-A" ? 20 : 40 } } }),
    });
    try {
      expect((await service.refresh("openai-codex")).providers[0]?.windows[0]?.usedPercent).toBe(20);
      await began; accountId = "fictional-B"; release();
      expect((await service.history!({ ...q, provider: "openai-codex" })).providers[0]?.samples[0]?.windows[0]?.usedPercent).toBe(20);
      time += 300_000; await service.refresh("openai-codex");
      const history = await service.history!({ ...q, provider: "openai-codex" });
      expect(history.providers[0]?.accountChanges).toHaveLength(1);
      expect(history.providers[0]?.samples.map(sample => sample.windows[0]?.usedPercent)).toEqual([20, 40]);
    } finally { release(); await service.stop(); }
  });
  it("does not turn a sink error into a vendor error or alter cache freshness", async () => {
    const append = vi.fn(async () => { throw new Error("fictional disk failure"); });
    const service = createProviderUsageService({ now: () => NOW, resolver: Object.assign(vi.fn(), { readCredential: async () => ({ type: "oauth", access: "fictional-token", expires: NOW + DAY }) }) as never,
      fetch: async () => Response.json({ five_hour: { utilization: 30 } }), history: { append, read: vi.fn(), clear: vi.fn() } });
    try { expect((await service.snapshot("anthropic")).providers[0]?.error).toBeUndefined(); await service.snapshot("anthropic"); await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1)); }
    finally { service.stop(); }
  });
});
