import type { Session } from "../lib/types";
import { channelColor, channelLabel, dateStr, fmtCost, hexA, timeStr } from "../lib/format";
import { CHANNEL_ORDER, MUTED, TEXT } from "../lib/tokens";
import { sessionStoreKey } from "../lib/store";

export const DEFAULT_EXCLUDED_CHANNELS = ["memory"] as const;

export interface ListFilterControls {
  excludedChannels: ReadonlySet<string>;
  outcome: string;
  instance: string;
  selectedBucket?: ActivityBucket;
}

export interface ChannelChip {
  key: string;
  label: string;
  active: boolean;
  n: number;
  bg: string;
  border: string;
  color: string;
}

export interface ActivityChannelSegment {
  key: string;
  label: string;
  color: string;
  pct: number;
  count: number;
}

export interface ActivityBucket {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  rangeLabel: string;
  runCount: number;
  notifiedCount: number;
  silentCount: number;
  cost: number;
  costLabel: string;
  dominantChannel: string;
  dominantLabel: string;
  dominantColor: string;
  intensityPct: number;
  channelSegments: ActivityChannelSegment[];
  runKeys: readonly string[];
  ariaLabel: string;
  title: string;
}

export function makeDefaultExcludedChannels(): Set<string> {
  return new Set(DEFAULT_EXCLUDED_CHANNELS);
}

export function clearExcludedChannels(): Set<string> {
  return new Set();
}

export function toggleExcludedChannel(excludedChannels: ReadonlySet<string>, channel: string): Set<string> {
  const next = new Set(excludedChannels);
  if (next.has(channel)) {
    next.delete(channel);
  } else {
    next.add(channel);
  }
  return next;
}

export function activityBucketLimit(isMobile: boolean): number {
  return isMobile ? 8 : 28;
}

export function sourceFor(session: Session): string {
  return session.sourceId ?? session.instance;
}

export function orderedChannelsForSessions(sessions: readonly Session[]): string[] {
  const present = new Set(sessions.map((session) => session.source));
  const ordered = CHANNEL_ORDER.filter((channel) => present.has(channel));
  const known = new Set<string>(CHANNEL_ORDER);
  const unknown = [...present].filter((channel) => !known.has(channel)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...unknown];
}

export function filterSessionsForList(sessions: readonly Session[], controls: ListFilterControls): Session[] {
  const filtered = sessions.filter((session) => {
    if (controls.excludedChannels.has(session.source)) return false;
    if (controls.outcome !== "all" && session.outcome !== controls.outcome) return false;
    if (controls.instance !== "all" && sourceFor(session) !== controls.instance) return false;
    return true;
  });

  if (!controls.selectedBucket) {
    return filtered;
  }
  const selectedKeys = new Set(controls.selectedBucket.runKeys);
  return filtered.filter((session) => selectedKeys.has(sessionStoreKey(session)));
}

export function buildChannelChips(
  sessions: readonly Session[],
  controls: Pick<ListFilterControls, "excludedChannels" | "outcome" | "instance">,
): ChannelChip[] {
  const base = sessions.filter((session) => {
    if (controls.outcome !== "all" && session.outcome !== controls.outcome) return false;
    if (controls.instance !== "all" && sourceFor(session) !== controls.instance) return false;
    return true;
  });
  const channelKeys = orderedChannelsForSessions(base);
  const allActive = channelKeys.every((channel) => !controls.excludedChannels.has(channel));
  return ["all", ...channelKeys].map((key) => {
    const active = key === "all" ? allActive : !controls.excludedChannels.has(key);
    const col = key === "all" ? TEXT : channelColor(key);
    const n = key === "all" ? base.length : base.filter((session) => session.source === key).length;
    return {
      key,
      label: key === "all" ? "All" : channelLabel(key),
      active,
      n,
      bg: active ? (key === "all" ? "rgba(255,255,255,.14)" : hexA(col, 0.16)) : "rgba(255,255,255,.03)",
      border: active ? hexA(col, 0.5) : "rgba(255,255,255,.1)",
      color: active ? col : MUTED,
    };
  });
}

export function buildActivityBuckets(
  sessions: readonly Session[],
  options: { maxBuckets: number },
): ActivityBucket[] {
  if (sessions.length === 0) return [];

  const maxBuckets = Math.max(1, Math.floor(options.maxBuckets));
  const times = sessions.map((session) => +new Date(session.startTs)).filter((value) => Number.isFinite(value));
  if (times.length === 0) return [];

  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const span = Math.max(1, maxMs - minMs);
  const degenerate = maxMs === minMs;
  const slotCount = Math.min(maxBuckets, Math.max(1, sessions.length));
  const buckets = new Map<number, Session[]>();

  for (const session of sessions) {
    const ts = +new Date(session.startTs);
    const index = degenerate ? 0 : Math.max(0, Math.min(slotCount - 1, Math.floor(((ts - minMs) / span) * slotCount)));
    const bucket = buckets.get(index) ?? [];
    bucket.push(session);
    buckets.set(index, bucket);
  }

  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const maxRunCount = Math.max(1, ...entries.map(([, bucket]) => bucket.length));

  return entries.map(([index, bucket]) => {
    const startMs = degenerate ? minMs : minMs + (index / slotCount) * span;
    const endMs = degenerate || index === slotCount - 1 ? maxMs : minMs + ((index + 1) / slotCount) * span;
    const channelCounts = new Map<string, number>();
    let cost = 0;
    let notifiedCount = 0;
    for (const session of bucket) {
      cost += session.totals.cost;
      if (session.outcome !== "silent") notifiedCount++;
      channelCounts.set(session.source, (channelCounts.get(session.source) ?? 0) + 1);
    }
    const silentCount = bucket.length - notifiedCount;
    const channelEntries = [...channelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const dominantChannel = channelEntries[0]?.[0] ?? "other";
    const rangeLabel = startMs === endMs
      ? `${dateStr(startMs)} ${timeStr(startMs)}`
      : `${dateStr(startMs)} ${timeStr(startMs)} - ${dateStr(endMs)} ${timeStr(endMs)}`;
    const costLabel = fmtCost(cost);
    const dominantLabel = channelLabel(dominantChannel);
    const runWord = bucket.length === 1 ? "run" : "runs";
    const notifiedPhrase = notifiedCount === 0 ? "all silent" : `${notifiedCount} notified, ${silentCount} silent`;
    const channelSegments = channelEntries.map(([key, count]) => ({
      key,
      label: channelLabel(key),
      color: channelColor(key),
      pct: (count / bucket.length) * 100,
      count,
    }));

    return {
      id: `${index}:${Math.round(startMs)}:${Math.round(endMs)}`,
      index,
      startMs,
      endMs,
      rangeLabel,
      runCount: bucket.length,
      notifiedCount,
      silentCount,
      cost,
      costLabel,
      dominantChannel,
      dominantLabel,
      dominantColor: channelColor(dominantChannel),
      intensityPct: Math.round((bucket.length / maxRunCount) * 100),
      channelSegments,
      runKeys: bucket.map((session) => sessionStoreKey(session)),
      ariaLabel: `${rangeLabel}: ${bucket.length} ${runWord}, ${notifiedPhrase}, ${costLabel}, mostly ${dominantLabel}.`,
      title: `${bucket.length} ${runWord} - ${rangeLabel} - ${notifiedPhrase} - ${costLabel}`,
    };
  });
}
