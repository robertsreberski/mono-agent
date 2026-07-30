import { describe, expect, it, vi } from "vitest";

import { SlackApiError } from "../slack-client.js";
import {
  SLACK_USER_DIRECTORY_LOOKUP_CONCURRENCY,
  SlackUserDirectory,
} from "../user-directory.js";
import type { SlackUsersInfoParams, SlackUsersInfoResult, SlackWebApi } from "../types.js";

type UsersApi = Pick<SlackWebApi, "usersInfo">;

interface FakeUsersApiOptions {
  readonly users?: Readonly<Record<string, SlackUsersInfoResult["user"]>>;
  readonly failure?: (userId: string) => unknown;
  /** Resolves before each lookup returns, so concurrency can be observed. */
  readonly gate?: () => Promise<void>;
}

class FakeUsersApi implements UsersApi {
  readonly calls: string[] = [];
  maxInFlight = 0;
  private inFlight = 0;

  constructor(private readonly options: FakeUsersApiOptions = {}) {}

  async usersInfo(params: SlackUsersInfoParams): Promise<SlackUsersInfoResult> {
    this.calls.push(params.userId);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.gate !== undefined) {
        await this.options.gate();
      }
      const failure = this.options.failure?.(params.userId);
      if (failure !== undefined) {
        throw failure;
      }
      const user = this.options.users?.[params.userId];
      return user === undefined ? { ok: true } : { ok: true, user };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function slackFailure(slackError: string, extra?: { needed?: string }): SlackApiError {
  return new SlackApiError("rejected", {
    kind: "slack",
    method: "users.info",
    slackError,
    ...(extra?.needed === undefined ? {} : { needed: extra.needed }),
  });
}

function directoryWith(
  api: UsersApi,
  overrides?: {
    now?: () => number;
    maxEntries?: number;
    ttlMs?: number;
    negativeTtlMs?: number;
    logger?: { warn?: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn> };
  },
): SlackUserDirectory {
  return new SlackUserDirectory({
    api,
    ...(overrides?.now === undefined ? {} : { now: overrides.now }),
    ...(overrides?.maxEntries === undefined ? {} : { maxEntries: overrides.maxEntries }),
    ...(overrides?.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
    ...(overrides?.negativeTtlMs === undefined ? {} : { negativeTtlMs: overrides.negativeTtlMs }),
    ...(overrides?.logger === undefined ? {} : { logger: overrides.logger }),
  });
}

describe("SlackUserDirectory", () => {
  it("resolves a display name and handle", async () => {
    const api = new FakeUsersApi({
      users: { U1: { name: "alice", profile: { display_name: "Alice Chen" } } },
    });
    const directory = directoryWith(api);

    const resolved = await directory.resolveMany(["U1"], undefined, 10);

    expect(resolved.get("U1")).toEqual({ displayName: "Alice Chen", handle: "alice" });
  });

  it("prefers profile.display_name, then profile.real_name, then real_name", async () => {
    const api = new FakeUsersApi({
      users: {
        U1: { profile: { display_name: "Display", real_name: "Profile Real" }, real_name: "Top Real" },
        U2: { profile: { real_name: "Profile Real" }, real_name: "Top Real" },
        U3: { real_name: "Top Real" },
      },
    });
    const directory = directoryWith(api);

    const resolved = await directory.resolveMany(["U1", "U2", "U3"], undefined, 10);

    expect(resolved.get("U1")?.displayName).toBe("Display");
    expect(resolved.get("U2")?.displayName).toBe("Profile Real");
    expect(resolved.get("U3")?.displayName).toBe("Top Real");
  });

  it("strips a leading @ from the handle and ignores blank name fields", async () => {
    const api = new FakeUsersApi({
      users: { U1: { name: "@bob", profile: { display_name: "   " } } },
    });
    const directory = directoryWith(api);

    expect(await directory.resolveMany(["U1"], undefined, 10)).toEqual(
      new Map([["U1", { handle: "bob" }]]),
    );
  });

  it("marks a bot sender with the transport-asserted isBot flag", async () => {
    const api = new FakeUsersApi({ users: { B1: { real_name: "Deploy Bot", is_bot: true } } });
    const directory = directoryWith(api);

    expect(await directory.resolveMany(["B1"], undefined, 10)).toEqual(
      new Map([["B1", { displayName: "Deploy Bot", isBot: true }]]),
    );
  });

  it("never turns a user id into a model-visible name", async () => {
    // A profile with no usable name must resolve to nothing rather than falling
    // back to the id: a Slack user id doubles as a DM channel id, so it is a
    // delivery target and must never reach the prompt.
    const api = new FakeUsersApi({ users: { U08ABC: { is_bot: false } } });
    const directory = directoryWith(api);

    const resolved = await directory.resolveMany(["U08ABC"], undefined, 10);

    expect(resolved.has("U08ABC")).toBe(false);
    expect(JSON.stringify([...resolved.values()])).not.toContain("U08ABC");
  });

  it("issues one lookup per distinct id within a batch and across batches", async () => {
    const api = new FakeUsersApi({ users: { U1: { real_name: "One" }, U2: { real_name: "Two" } } });
    const directory = directoryWith(api);

    await directory.resolveMany(["U1", "U2", "U1"], undefined, 10);
    await directory.resolveMany(["U1", "U2"], undefined, 10);

    expect(api.calls).toEqual(["U1", "U2"]);
  });

  it("skips blank ids without calling Slack", async () => {
    const api = new FakeUsersApi();
    const directory = directoryWith(api);

    const resolved = await directory.resolveMany(["", "   "], undefined, 10);

    expect(api.calls).toEqual([]);
    expect(resolved.size).toBe(0);
  });

  it("re-fetches a cached name once its TTL expires", async () => {
    let clock = 1_000;
    const api = new FakeUsersApi({ users: { U1: { real_name: "One" } } });
    const directory = directoryWith(api, { now: () => clock, ttlMs: 60_000 });

    await directory.resolveMany(["U1"], undefined, 10);
    clock += 59_999;
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(1);

    clock += 2;
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(2);
  });

  it("negative-caches an unresolvable user and retries after the negative TTL", async () => {
    let clock = 1_000;
    const api = new FakeUsersApi({ failure: () => slackFailure("user_not_found") });
    const directory = directoryWith(api, { now: () => clock, negativeTtlMs: 5_000 });

    expect((await directory.resolveMany(["U1"], undefined, 10)).size).toBe(0);
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(1);

    clock += 5_001;
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(2);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const api = new FakeUsersApi({
      users: { U1: { real_name: "One" }, U2: { real_name: "Two" }, U3: { real_name: "Three" } },
    });
    const directory = directoryWith(api, { maxEntries: 2 });

    await directory.resolveMany(["U1", "U2"], undefined, 10);
    await directory.resolveMany(["U3"], undefined, 10);
    // U1 was evicted, so it costs a second lookup; U3 is still cached.
    await directory.resolveMany(["U1", "U3"], undefined, 10);

    expect(api.calls).toEqual(["U1", "U2", "U3", "U1"]);
  });

  it("latches off after missing_scope so a mis-scoped app pays one call, not one per speaker", async () => {
    const warn = vi.fn();
    const api = new FakeUsersApi({
      failure: () => slackFailure("missing_scope", { needed: "users:read" }),
    });
    const directory = directoryWith(api, { logger: { warn } });

    expect(directory.unavailable).toBe(false);
    for (const round of ["U1", "U2", "U3"]) {
      expect((await directory.resolveMany([round], undefined, 10)).size).toBe(0);
    }

    expect(api.calls).toEqual(["U1"]);
    expect(directory.unavailable).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ needed: "users:read" });
  });

  it("reports unavailable and makes no calls when the client omits usersInfo", async () => {
    const debug = vi.fn();
    const directory = directoryWith({}, { logger: { debug } });

    const resolved = await directory.resolveMany(["U1"], undefined, 10);

    expect(resolved.size).toBe(0);
    expect(directory.unavailable).toBe(true);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("does not latch on a rate limit, since users.info recovers quickly", async () => {
    let clock = 1_000;
    const api = new FakeUsersApi({ failure: () => slackFailure("ratelimited") });
    const directory = directoryWith(api, { now: () => clock, negativeTtlMs: 5_000 });

    await directory.resolveMany(["U1"], undefined, 10);

    expect(directory.unavailable).toBe(false);
    // Negative-cached, so an immediate retry does not hammer Slack...
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(1);
    // ...but a different id is still attempted.
    await directory.resolveMany(["U2"], undefined, 10);
    expect(api.calls).toEqual(["U1", "U2"]);
    clock += 5_001;
    await directory.resolveMany(["U1"], undefined, 10);
    expect(api.calls).toHaveLength(3);
  });

  it("survives a non-Slack throw from the client", async () => {
    const api = new FakeUsersApi({ failure: () => new TypeError("boom") });
    const directory = directoryWith(api);

    await expect(directory.resolveMany(["U1"], undefined, 10)).resolves.toEqual(new Map());
    expect(directory.unavailable).toBe(false);
  });

  it("bounds lookup concurrency", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = new FakeUsersApi({ gate: () => gate });
    const directory = directoryWith(api);

    const pending = directory.resolveMany(
      Array.from({ length: 12 }, (_, index) => `U${String(index)}`),
      undefined,
      12,
    );
    await Promise.resolve();
    release();
    await pending;

    expect(api.maxInFlight).toBeLessThanOrEqual(SLACK_USER_DIRECTORY_LOOKUP_CONCURRENCY);
    expect(api.calls).toHaveLength(12);
  });

  it("caps the number of uncached lookups per batch", async () => {
    const api = new FakeUsersApi({ users: { U1: { real_name: "One" } } });
    const directory = directoryWith(api);

    const resolved = await directory.resolveMany(["U1", "U2", "U3", "U4"], undefined, 2);

    expect(api.calls).toHaveLength(2);
    expect(resolved.size).toBeLessThanOrEqual(2);
  });

  it("stops early and never rejects when the turn is aborted", async () => {
    const controller = new AbortController();
    const api = new FakeUsersApi({
      users: { U1: { real_name: "One" } },
      gate: async () => {
        controller.abort();
      },
    });
    const directory = directoryWith(api);

    await expect(
      directory.resolveMany(
        Array.from({ length: 9 }, (_, index) => `U${String(index)}`),
        controller.signal,
        10,
      ),
    ).resolves.toBeInstanceOf(Map);
    // Only the first concurrent wave runs; the rest see the aborted signal.
    expect(api.calls.length).toBeLessThanOrEqual(SLACK_USER_DIRECTORY_LOOKUP_CONCURRENCY);
  });
});
