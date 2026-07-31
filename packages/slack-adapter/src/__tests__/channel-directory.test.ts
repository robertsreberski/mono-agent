import { describe, expect, it, vi } from "vitest";

import { SlackChannelDirectory } from "../channel-directory.js";
import { SlackApiError } from "../slack-client.js";
import type {
  SlackConversationsInfoParams,
  SlackConversationsInfoResult,
  SlackWebApi,
} from "../types.js";

type ChannelsApi = Pick<SlackWebApi, "conversationsInfo">;

function slackFailure(slackError: string): SlackApiError {
  return new SlackApiError("rejected", {
    kind: "slack",
    method: "conversations.info",
    slackError,
  });
}

interface FakeChannelsApiOptions {
  readonly channels?: Readonly<Record<string, SlackConversationsInfoResult["channel"]>>;
  readonly failure?: (channelId: string) => unknown;
}

class FakeChannelsApi implements ChannelsApi {
  readonly calls: string[] = [];

  constructor(private readonly options: FakeChannelsApiOptions = {}) {}

  async conversationsInfo(
    params: SlackConversationsInfoParams,
  ): Promise<SlackConversationsInfoResult> {
    this.calls.push(params.channelId);
    const failure = this.options.failure?.(params.channelId);
    if (failure !== undefined) {
      throw failure;
    }
    const channel = this.options.channels?.[params.channelId];
    return channel === undefined ? { ok: true } : { ok: true, channel };
  }
}

describe("SlackChannelDirectory", () => {
  it("names a public channel and classifies it as shared", async () => {
    const api = new FakeChannelsApi({
      channels: { C1: { name: "team-example", is_channel: true } },
    });
    const directory = new SlackChannelDirectory({ api });

    expect(await directory.resolve("C1", undefined)).toEqual({
      name: "team-example",
      kind: "channel",
    });
  });

  it("treats a private channel as a channel — shared is shared", async () => {
    const api = new FakeChannelsApi({
      channels: { C2: { name: "secret-plans", is_channel: true, is_private: true } },
    });
    const directory = new SlackChannelDirectory({ api });

    expect(await directory.resolve("C2", undefined)).toEqual({
      name: "secret-plans",
      kind: "channel",
    });
  });

  it("classifies an im as a dm and refuses to name it", async () => {
    // Slack returns bookkeeping in `name` for an im; the DM counterpart is
    // already named by the turn's speaker label.
    const api = new FakeChannelsApi({ channels: { D1: { is_im: true, name: "mpdm-bookkeeping" } } });
    const directory = new SlackChannelDirectory({ api });

    expect(await directory.resolve("D1", undefined)).toEqual({ kind: "dm" });
  });

  it("classifies a multi-person DM as a group", async () => {
    const api = new FakeChannelsApi({ channels: { G1: { is_mpim: true, name: "mpdm-a--b--c" } } });
    const directory = new SlackChannelDirectory({ api });

    expect(await directory.resolve("G1", undefined)).toEqual({
      kind: "group",
      name: "mpdm-a--b--c",
    });
  });

  it("strips a decorative leading # from a channel name", async () => {
    const api = new FakeChannelsApi({ channels: { C1: { name: "#team-example", is_channel: true } } });
    const directory = new SlackChannelDirectory({ api });

    expect((await directory.resolve("C1", undefined))?.name).toBe("team-example");
  });

  it("serves a cached hit without a second API call", async () => {
    const api = new FakeChannelsApi({ channels: { C1: { name: "team", is_channel: true } } });
    const directory = new SlackChannelDirectory({ api });

    await directory.resolve("C1", undefined);
    await directory.resolve("C1", undefined);

    expect(api.calls).toEqual(["C1"]);
  });

  it("re-looks-up once the entry expires", async () => {
    let now = 0;
    const api = new FakeChannelsApi({ channels: { C1: { name: "team", is_channel: true } } });
    const directory = new SlackChannelDirectory({ api, ttlMs: 1_000, now: () => now });

    await directory.resolve("C1", undefined);
    now = 1_001;
    await directory.resolve("C1", undefined);

    expect(api.calls).toEqual(["C1", "C1"]);
  });

  it("negative-caches a recoverable failure instead of retrying every turn", async () => {
    let now = 0;
    const api = new FakeChannelsApi({
      failure: () => slackFailure("channel_not_found"),
    });
    const directory = new SlackChannelDirectory({ api, negativeTtlMs: 1_000, now: () => now });

    expect(await directory.resolve("C1", undefined)).toBeUndefined();
    expect(await directory.resolve("C1", undefined)).toBeUndefined();
    expect(api.calls).toEqual(["C1"]);
    // …but it recovers on its own once the negative entry lapses.
    now = 1_001;
    await directory.resolve("C1", undefined);
    expect(api.calls).toEqual(["C1", "C1"]);
    expect(directory.unavailable).toBe(false);
  });

  it("latches off permanently on missing_scope, warning once", async () => {
    const warn = vi.fn();
    const api = new FakeChannelsApi({
      failure: () => slackFailure("missing_scope"),
    });
    const directory = new SlackChannelDirectory({ api, logger: { warn } });

    expect(await directory.resolve("C1", undefined)).toBeUndefined();
    expect(directory.unavailable).toBe(true);
    expect(await directory.resolve("C2", undefined)).toBeUndefined();

    // A mis-scoped app pays exactly one call, not one per channel per turn.
    expect(api.calls).toEqual(["C1"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps serving cached names after latching off", async () => {
    let fail = false;
    const api = new FakeChannelsApi({
      channels: { C1: { name: "team", is_channel: true } },
      failure: () => (fail ? slackFailure("missing_scope") : undefined),
    });
    const directory = new SlackChannelDirectory({ api });

    await directory.resolve("C1", undefined);
    fail = true;
    await directory.resolve("C2", undefined);
    expect(directory.unavailable).toBe(true);

    // Losing the scope mid-process degrades gradually rather than all at once.
    expect((await directory.resolve("C1", undefined))?.name).toBe("team");
  });

  it("latches off when the client has no conversations.info at all", async () => {
    const directory = new SlackChannelDirectory({ api: {} });

    expect(await directory.resolve("C1", undefined)).toBeUndefined();
    expect(directory.unavailable).toBe(true);
  });

  it("never rejects, whatever the transport does", async () => {
    const api = new FakeChannelsApi({ failure: () => new Error("socket hang up") });
    const directory = new SlackChannelDirectory({ api });

    await expect(directory.resolve("C1", undefined)).resolves.toBeUndefined();
  });

  it("resolves nothing for a blank id without calling Slack", async () => {
    const api = new FakeChannelsApi();
    const directory = new SlackChannelDirectory({ api });

    expect(await directory.resolve("   ", undefined)).toBeUndefined();
    expect(api.calls).toEqual([]);
  });

  it("evicts oldest-first once the entry budget is reached", async () => {
    const api = new FakeChannelsApi({
      channels: {
        C1: { name: "one", is_channel: true },
        C2: { name: "two", is_channel: true },
        C3: { name: "three", is_channel: true },
      },
    });
    const directory = new SlackChannelDirectory({ api, maxEntries: 2 });

    await directory.resolve("C1", undefined);
    await directory.resolve("C2", undefined);
    await directory.resolve("C3", undefined);
    // C1 was evicted to make room for C3, so asking again costs a lookup.
    await directory.resolve("C1", undefined);

    expect(api.calls).toEqual(["C1", "C2", "C3", "C1"]);
  });
});
