import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "../../ai/runtime/sessions.js";
import { createSessionLiveness } from "../../ai/runtime/session-liveness.js";

// Build a registry + liveness pair with a controllable clock and a fake repo so
// idle-TTL eviction and onEvict fan-out are observable.
function setup({ idleTimeoutMs = 60_000 } = {}) {
  const evicted = [];
  let clock = 0;
  const registry = createSessionRegistry({
    idleTimeoutMs,
    now: () => clock,
    isBusy: (entry) => entry.busy === true,
    onEvict: async (entry, reason) => { evicted.push({ entry, reason }); },
  });
  const liveness = createSessionLiveness(registry);
  return { registry, liveness, evicted, advance: (ms) => { clock += ms; } };
}

const seed = (over = {}) => ({ session: {}, metadata: {}, repo: {}, durable: false, busy: false, ...over });

describe("createSessionLiveness — claim", () => {
  it("reports missing for an id with no live entry", () => {
    const { liveness } = setup();
    expect(liveness.claim("nope")).toEqual({ ok: false, reason: "missing" });
  });

  it("claims a free entry and sets busy synchronously", () => {
    const { registry, liveness } = setup();
    const entry = seed();
    registry.set("s1", entry);
    const claimed = liveness.claim("s1");
    expect(claimed).toEqual({ ok: true, entry });
    // busy set on the stored object in the same call — no await needed.
    expect(entry.busy).toBe(true);
    expect(registry.get("s1").busy).toBe(true);
  });

  it("a second concurrent claim of a busy entry loses with reason busy", () => {
    const { registry, liveness } = setup();
    registry.set("s1", seed());
    const first = liveness.claim("s1");
    const second = liveness.claim("s1");
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "busy" });
  });
});

describe("createSessionLiveness — reserve (R8 placeholder)", () => {
  it("inserts a busy placeholder when the id is free and hands back release/commit", () => {
    const { registry, liveness } = setup();
    const placeholder = seed({ session: null, busy: true });
    const reservation = liveness.reserve("s1", placeholder, 60_000);
    expect(reservation.ok).toBe(true);
    // placeholder is live + busy: a concurrent claim would lose.
    expect(registry.get("s1")).toBe(placeholder);
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "busy" });
  });

  it("loses the reservation when a concurrent entry already holds the id", () => {
    const { registry, liveness } = setup();
    const existing = seed();
    registry.set("s1", existing);
    const reservation = liveness.reserve("s1", seed({ busy: true }), 60_000);
    expect(reservation).toEqual({ ok: false, entry: existing });
    // the existing entry is untouched (no placeholder overwrite).
    expect(registry.get("s1")).toBe(existing);
  });

  it("commit overwrites the placeholder with the finalized entry", () => {
    const { registry, liveness } = setup();
    const reservation = liveness.reserve("s1", seed({ session: null, busy: true }), 60_000);
    if (!reservation.ok) throw new Error("expected reservation");
    const finalized = seed({ busy: false });
    reservation.commit(finalized);
    expect(registry.get("s1")).toBe(finalized);
    expect(registry.get("s1").busy).toBe(false);
  });

  it("release drops the placeholder", () => {
    const { registry, liveness } = setup();
    const reservation = liveness.reserve("s1", seed({ busy: true }), 60_000);
    if (!reservation.ok) throw new Error("expected reservation");
    reservation.release();
    expect(registry.get("s1")).toBeUndefined();
  });
});

describe("createSessionLiveness — reserve then claim interleaving (concurrent first turns)", () => {
  it("the reservation winner creates; the loser adopts the placeholder and is told busy", () => {
    const { liveness } = setup();
    // Turn A reserves the durable id first (winner).
    const winner = liveness.reserve("conv", seed({ session: null, busy: true }), 60_000);
    expect(winner.ok).toBe(true);
    // Turn B misses, tries to reserve → loses (placeholder present), then falls
    // into the busy claim path exactly as pi-native's resolveSession does.
    const loserReserve = liveness.reserve("conv", seed({ busy: true }), 60_000);
    expect(loserReserve.ok).toBe(false);
    const loserClaim = liveness.claim("conv");
    expect(loserClaim).toEqual({ ok: false, reason: "busy" });
  });
});

describe("createSessionLiveness — adoptIfPresent (F4 post-await re-read)", () => {
  it("returns the live entry (possibly busy) or null", () => {
    const { registry, liveness } = setup();
    expect(liveness.adoptIfPresent("s1")).toBeNull();
    const busyEntry = seed({ busy: true });
    registry.set("s1", busyEntry);
    expect(liveness.adoptIfPresent("s1")).toBe(busyEntry);
  });
});

describe("createSessionLiveness — release + idle-TTL invariants", () => {
  it("release removes without running onEvict", () => {
    const { registry, liveness, evicted } = setup();
    registry.set("s1", seed());
    liveness.release("s1");
    expect(registry.get("s1")).toBeUndefined();
    expect(evicted).toHaveLength(0);
  });

  it("a claimed (busy) entry is not idle-evicted by the lazy wall-clock check", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed());
    liveness.claim("s1");
    advance(10_000);
    // busy entries survive the lazy TTL sweep (I11): still adoptable.
    expect(liveness.adoptIfPresent("s1")).not.toBeNull();
  });

  it("a free entry past its TTL is lazily evicted on read", () => {
    const { registry, liveness, advance } = setup({ idleTimeoutMs: 1_000 });
    registry.set("s1", seed());
    advance(10_000);
    expect(liveness.adoptIfPresent("s1")).toBeNull();
    expect(liveness.claim("s1")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("createSessionLiveness — fake timers idle eviction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the idle timer evicts a free entry and runs onEvict", async () => {
    const evicted = [];
    const registry = createSessionRegistry({
      idleTimeoutMs: 5_000,
      isBusy: (entry) => entry.busy === true,
      onEvict: async (entry, reason) => { evicted.push(reason); },
    });
    const liveness = createSessionLiveness(registry);
    registry.set("s1", seed());
    liveness.claim("s1");
    // busy → the timer fires but re-arms instead of evicting.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evicted).toHaveLength(0);
    // release the busy flag; next timer window evicts.
    registry.get("s1").busy = false;
    registry.touch("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evicted).toEqual(["idle_timeout"]);
  });
});
