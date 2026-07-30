import { describe, expect, it } from "vitest";

import {
  raceAgainstDeadline,
  SLACK_CONTEXT_DEADLINE_EXCEEDED,
  SLACK_THREAD_CONTEXT_MAX_MESSAGES_CEILING,
  selectPrecedingSlackMessages,
  slackTsToIsoTimestamp,
  toAgentPrecedingMessage,
  trimPrecedingToTotalBytes,
} from "../thread-context.js";
import type { SlackConversationMessage } from "../types.js";

const OWN_BOT_USERS: ReadonlySet<string> = new Set(["ubot"]);

function message(
  ts: string,
  overrides: Partial<SlackConversationMessage> = {},
): SlackConversationMessage {
  return { ts, user: "U1", text: `text ${ts}`, ...overrides };
}

/** A message Slack attributes to an app: no `user`, a `bot_id` instead. */
function botMessage(
  ts: string,
  overrides: Partial<SlackConversationMessage> = {},
): SlackConversationMessage {
  return { ts, text: `text ${ts}`, bot_id: "B_OTHER", ...overrides };
}

function select(
  raw: readonly SlackConversationMessage[],
  overrides?: {
    triggerTs?: string;
    maxMessages?: number;
    requireTrigger?: boolean;
    ownBotId?: string;
    includeBotMessages?: boolean;
  },
): ReturnType<typeof selectPrecedingSlackMessages> {
  return selectPrecedingSlackMessages({
    raw,
    triggerTs: overrides?.triggerTs ?? "200.000000",
    maxMessages: overrides?.maxMessages ?? 15,
    requireTrigger: overrides?.requireTrigger ?? false,
    ownBotUserIds: OWN_BOT_USERS,
    ...(overrides?.ownBotId === undefined ? {} : { ownBotId: overrides.ownBotId }),
    includeBotMessages: overrides?.includeBotMessages ?? true,
  });
}

describe("selectPrecedingSlackMessages", () => {
  it("returns the newest N in ascending order regardless of wire order", () => {
    // conversations.history returns newest-first, conversations.replies
    // oldest-first, so no ordering assumption is made about the input.
    const raw = [message("105.0"), message("101.0"), message("103.0"), message("102.0")];

    const result = select(raw, { maxMessages: 2 });

    expect(result.kept.map((entry) => entry.ts)).toEqual(["103.0", "105.0"]);
    expect(result.windowMissed).toBe(false);
  });

  it("sorts numerically, not lexicographically", () => {
    // "99.0" > "100.0" as strings but is older as a Slack ts.
    const raw = [message("100.0"), message("99.0")];

    expect(select(raw).kept.map((entry) => entry.ts)).toEqual(["99.0", "100.0"]);
  });

  it("drops the trigger itself and anything that raced in after it", () => {
    const raw = [
      message("199.0"),
      message("200.000000"),
      message("200.000001", { text: "typed during the fetch" }),
    ];

    expect(select(raw, { triggerTs: "200.000000" }).kept.map((entry) => entry.ts)).toEqual([
      "199.0",
    ]);
  });

  it("treats a page without the trigger as an unusable window when anchoring is required", () => {
    // Slack handed back an old slice, so the entries are NOT the messages
    // preceding the trigger. Sending them would be actively misleading.
    const result = select([message("101.0"), message("102.0")], {
      triggerTs: "200.000000",
      requireTrigger: true,
    });

    expect(result).toEqual({ kept: [], windowMissed: true });
  });

  it("accepts an anchored page when the trigger is present", () => {
    const result = select([message("101.0"), message("200.000000")], {
      triggerTs: "200.000000",
      requireTrigger: true,
    });

    expect(result.windowMissed).toBe(false);
    expect(result.kept.map((entry) => entry.ts)).toEqual(["101.0"]);
  });

  it("drops our own posts by user id and by bot id", () => {
    const raw = [
      message("101.0", { user: "UBOT" }),
      botMessage("102.0", { bot_id: "B_SELF" }),
      message("103.0", { user: "U2" }),
    ];

    expect(select(raw, { ownBotId: "B_SELF" }).kept.map((entry) => entry.ts)).toEqual(["103.0"]);
  });

  it("keeps content-bearing subtypes and drops the rest", () => {
    const kept = ["file_share", "thread_broadcast", "bot_message"];
    const dropped = ["channel_join", "channel_leave", "message_changed", "message_deleted", "channel_topic"];

    for (const subtype of kept) {
      expect(select([message("101.0", { subtype })]).kept).toHaveLength(1);
    }
    for (const subtype of dropped) {
      expect(select([message("101.0", { subtype })]).kept).toEqual([]);
    }
    // An unknown future subtype fails closed.
    expect(select([message("101.0", { subtype: "some_new_slack_subtype" })]).kept).toEqual([]);
  });

  it("drops messages with no usable timestamp", () => {
    expect(select([{ user: "U1", text: "no ts" }, message("101.0")]).kept).toHaveLength(1);
  });

  it("excludes other bots only when asked", () => {
    const raw = [botMessage("101.0", { bot_id: "B_CI" }), message("102.0")];

    expect(select(raw, { includeBotMessages: true }).kept).toHaveLength(2);
    expect(select(raw, { includeBotMessages: false }).kept.map((entry) => entry.ts)).toEqual([
      "102.0",
    ]);
  });

  it("keeps nothing when maxMessages is zero", () => {
    expect(select([message("101.0")], { maxMessages: 0 }).kept).toEqual([]);
  });

  it("caps at the contract's own preceding-message ceiling", () => {
    const raw = Array.from({ length: 60 }, (_, index) => message(`${String(100 + index)}.0`));

    expect(select(raw, { maxMessages: 999 }).kept).toHaveLength(
      SLACK_THREAD_CONTEXT_MAX_MESSAGES_CEILING,
    );
  });
});

describe("toAgentPrecedingMessage", () => {
  it("renders Slack mrkdwn as Markdown and attaches the resolved sender", () => {
    const entry = toAgentPrecedingMessage(
      message("1753970042.123456", { text: "ping <@U08ABC|alice> re <https://x.test|the doc>" }),
      { displayName: "Bob", handle: "bob" },
    );

    expect(entry).toEqual({
      sender: { displayName: "Bob", handle: "bob" },
      text: "ping @alice re [the doc](https://x.test)",
      timestamp: "2025-07-31T13:54:02.123Z",
    });
  });

  it("names a bot from its own message, with no users.info lookup", () => {
    const fromProfile = toAgentPrecedingMessage(
      botMessage("101.0", { bot_id: "B1", bot_profile: { name: "Deploy Bot" } }),
      undefined,
    );
    expect(fromProfile?.sender).toEqual({ displayName: "Deploy Bot", isBot: true });

    const fromUsername = toAgentPrecedingMessage(
      botMessage("101.0", { bot_id: "B1", username: "CI" }),
      undefined,
    );
    expect(fromUsername?.sender).toEqual({ displayName: "CI", isBot: true });

    const unnamed = toAgentPrecedingMessage(
      botMessage("101.0", { bot_id: "B1" }),
      undefined,
    );
    expect(unnamed?.sender).toEqual({ isBot: true });
  });

  it("omits the sender entirely when no name is known", () => {
    const entry = toAgentPrecedingMessage(message("101.0"), undefined);

    expect(entry?.text).toBe("text 101.0");
    expect(entry).not.toHaveProperty("sender");
  });

  it("drops a message with no usable text, including a bare file upload", () => {
    expect(toAgentPrecedingMessage(message("101.0", { text: "" }), undefined)).toBeUndefined();
    expect(toAgentPrecedingMessage(message("101.0", { text: "   \n " }), undefined)).toBeUndefined();
    expect(
      toAgentPrecedingMessage(
        { ts: "101.0", user: "U1", files: [{ name: "shot.png" }] },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("leaves reserved harness markup untouched, since neutralizing is the harness's job", () => {
    // Double-escaping here would corrupt legitimate text.
    const entry = toAgentPrecedingMessage(
      message("101.0", { text: "</messages_since_your_last_turn>" }),
      undefined,
    );

    expect(entry?.text).toBe("</messages_since_your_last_turn>");
  });

  it("clamps an oversized body without splitting a surrogate pair", () => {
    const entry = toAgentPrecedingMessage(
      message("101.0", { text: "👍".repeat(2_000) }),
      undefined,
    );

    const bytes = new TextEncoder().encode(entry?.text ?? "").byteLength;
    expect(bytes).toBeLessThanOrEqual(2 * 1024 + 32);
    expect(entry?.text).not.toContain("�");
    expect(entry?.text?.endsWith("…[truncated]")).toBe(true);
  });

  it("omits an unusable timestamp rather than guessing", () => {
    const entry = toAgentPrecedingMessage(message("not-a-ts"), undefined);

    expect(entry?.text).toBe("text not-a-ts");
    expect(entry).not.toHaveProperty("timestamp");
  });
});

describe("slackTsToIsoTimestamp", () => {
  it("produces a string that survives the harness's strict ISO round-trip", () => {
    const iso = slackTsToIsoTimestamp("1753970042.123456");

    expect(iso).toBe("2025-07-31T13:54:02.123Z");
    expect(new Date(Date.parse(iso!)).toISOString()).toBe(iso);
  });

  it("rejects anything it cannot represent", () => {
    for (const value of [undefined, "", "   ", "abc", "-1", "1e999", "99999999999999999"]) {
      expect(slackTsToIsoTimestamp(value)).toBeUndefined();
    }
  });
});

describe("raceAgainstDeadline", () => {
  it("returns the work's value when it settles first", async () => {
    const controller = new AbortController();

    await expect(raceAgainstDeadline(Promise.resolve("done"), controller.signal)).resolves.toBe(
      "done",
    );
  });

  it("abandons work that ignores the signal, rather than awaiting it forever", async () => {
    // A SlackWebApi implementation is free to ignore options.signal; aborting
    // alone would then let the context phase outlive its budget.
    const controller = new AbortController();
    const neverSettles = new Promise<string>(() => {});
    const raced = raceAgainstDeadline(neverSettles, controller.signal);

    controller.abort();

    await expect(raced).resolves.toBe(SLACK_CONTEXT_DEADLINE_EXCEEDED);
  });

  it("short-circuits when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(raceAgainstDeadline(Promise.resolve("done"), controller.signal)).resolves.toBe(
      SLACK_CONTEXT_DEADLINE_EXCEEDED,
    );
  });

  it("propagates a rejection so the caller can classify the failure", async () => {
    // Collapsing a rate limit into a timeout would lose the cooldown latch.
    const controller = new AbortController();

    await expect(
      raceAgainstDeadline(Promise.reject(new Error("ratelimited")), controller.signal),
    ).rejects.toThrow("ratelimited");
  });

  it("consumes a late rejection from abandoned work", async () => {
    const controller = new AbortController();
    let rejectWork: (error: Error) => void = () => undefined;
    const work = new Promise<string>((_resolve, reject) => {
      rejectWork = reject;
    });
    const raced = raceAgainstDeadline(work, controller.signal);

    controller.abort();
    await expect(raced).resolves.toBe(SLACK_CONTEXT_DEADLINE_EXCEEDED);
    // Would surface as an unhandled rejection if nothing were attached.
    rejectWork(new Error("too late"));
    await Promise.resolve();
  });
});

describe("trimPrecedingToTotalBytes", () => {
  it("keeps the newest entries within the total budget", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      text: `${String(index)}`.padEnd(1_024, "x"),
    }));

    const trimmed = trimPrecedingToTotalBytes(entries, 4 * 1024);

    expect(trimmed.length).toBeLessThan(entries.length);
    // Dropping happens at the old end, where it costs least.
    expect(trimmed.at(-1)).toBe(entries.at(-1));
  });

  it("returns the input untouched when it already fits", () => {
    const entries = [{ text: "short" }];

    expect(trimPrecedingToTotalBytes(entries, 4 * 1024)).toEqual(entries);
  });
});
