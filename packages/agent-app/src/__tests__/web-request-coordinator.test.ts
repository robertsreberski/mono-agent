import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createHostWebRequestCoordinator } from "../web-request-coordinator.js";
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => { for (const c of children.splice(0)) c.kill(); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "web-control-test-"))); roots.push(directory);
  return { directory, coordinator: createHostWebRequestCoordinator({ directory, spacingScale: 0 }) };
}
function request(signal?: AbortSignal) { return { kind: "codex" as const, key: "codex", deadlineMs: Date.now() + 10000, ...(signal ? { signal } : {}) }; }
function worker(directory: string) {
  const child = fork(new URL("./fixtures/web-control-worker.mjs", import.meta.url), [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child); return child;
}
function message(child: ChildProcess): Promise<unknown> { return new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => { if (code) reject(new Error(`Worker exited ${code}`)); }); }); }

describe("host web request coordinator", () => {
  it("admits SearXNG and Ollama as first-class buckets without persisting request material", async () => {
    const { directory, coordinator } = await setup();
    for (const kind of ["searxng", "ollama"] as const) {
      const permit = await coordinator.acquire({
        kind,
        key: `${kind}:query-and-credential-sentinel`,
        deadlineMs: Date.now() + 10000,
      });
      await permit.complete({ status: "ok" });
    }
    const state = await readFile(join(directory, "state.json"), "utf8");
    expect(state).not.toContain("query-and-credential-sentinel");
    const inspection = (await coordinator.inspect()) as { buckets: { backend: string }[] };
    expect(inspection.buckets.map((bucket) => bucket.backend)).toEqual(["searxng", "ollama"]);
  });
  it("shares cooldowns and quota without persisting request content", async () => {
    const { directory, coordinator } = await setup();
    const permit = await coordinator.acquire(request());
    const retryAtMs = Date.now() + 60000;
    await permit.complete({ status: "rate_limited", retryAfterMs: 1000, retryAtMs });
    const sibling = createHostWebRequestCoordinator({ directory });
    await expect(sibling.acquire(request())).rejects.toMatchObject({
      code: "rate_limited",
      retryAtMs,
      retryAfterMs: expect.any(Number),
    });
    await coordinator.writeQuota({ windows: [{ usedPercent: 91, resetsAt: 1900000000 }] });
    expect((await sibling.readQuota())?.value).toEqual({ windows: [{ usedPercent: 91, resetsAt: 1900000000 }] });
    const state = await readFile(join(directory, "state.json"), "utf8");
    expect(state).not.toContain('"query"');
    await coordinator.reset();
    expect(await sibling.readQuota()).toBeUndefined();
  });
  it("does not grant a waiting caller a slot after cancellation", async () => {
    const { coordinator } = await setup();
    const first = await coordinator.acquire(request());
    const abort = new AbortController();
    const pending = coordinator.acquire(request(abort.signal));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await expect(coordinator.reset()).rejects.toThrow(/active/);
    await first.complete({ status: "ok" });
    const next = await coordinator.acquire(request());
    await next.complete({ status: "ok" });
  });
  it("fails closed on corrupt shared state", async () => {
    const { directory, coordinator } = await setup();
    await writeFile(join(directory, "state.json"), "broken", { mode: 0o600 });
    await expect(coordinator.acquire(request())).rejects.toMatchObject({ code: "coordination_unavailable" });
  });
  it("bounds aggregate admission across processes and recovers a dead owner", async () => {
    const { directory, coordinator } = await setup();
    const first = worker(directory);
    expect(await message(first)).toEqual({ acquired: true });
    const second = worker(directory);
    let acquired = false;
    const pending = message(second).then((m) => { acquired = true; return m; });
    await new Promise((r) => setTimeout(r, 200));
    expect(acquired).toBe(false);
    first.kill("SIGKILL");
    expect(await pending).toEqual({ acquired: true });
    second.send("release");
    expect(await message(second)).toEqual({ released: true });
    const final = await coordinator.acquire(request());
    await final.complete({ status: "ok" });
  }, 15000);
  it("keeps a fetch cooldown despite late success and admits one recovery probe", async () => {
    const { directory } = await setup(); let now = Date.now();
    const coordinator = createHostWebRequestCoordinator({ directory, now: () => now, spacingScale: 0 });
    const fetchRequest = (signal?: AbortSignal) => ({ kind: "fetch" as const, key: "https://example.com", deadlineMs: now + 10000, ...(signal ? { signal } : {}) });
    const first = await coordinator.acquire(fetchRequest());
    const second = await coordinator.acquire(fetchRequest());
    await first.complete({ status: "rate_limited" });
    await second.complete({ status: "ok" });
    await expect(coordinator.acquire(fetchRequest())).rejects.toMatchObject({ code: "rate_limited" });
    now += 60001;
    const probe = await coordinator.acquire(fetchRequest());
    const abort = new AbortController();
    let admitted = false;
    const competing = coordinator.acquire(fetchRequest(abort.signal)).then((p) => { admitted = true; return p; });
    await new Promise((r) => setTimeout(r, 150));
    expect(admitted).toBe(false);
    abort.abort(); await expect(competing).rejects.toThrow();
    await probe.complete({ status: "rate_limited" });
    await expect(coordinator.acquire(fetchRequest())).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 120000 });
  });
});
