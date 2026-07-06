import { useEffect, useMemo, useState } from "react";
import type { Session, WebInstance } from "../lib/types";
import {
  timeStr,
  dateStr,
  dow,
  fmtDur,
  fmtTok,
  fmtCost,
  hexA,
  channelOf,
  channelColor,
  channelLabel,
  segsFor,
  outcomeInfo,
} from "../lib/format";
import { FONT_MONO, FONT_UI, TEXT, MUTED, DIM, DIMMER, AMBER, BLUE, TEAL, VIOLET, type Style } from "../lib/tokens";
import { sessionStoreKey } from "../lib/store";
import { useIsMobile } from "../lib/useIsMobile";
import {
  activityBucketLimit,
  buildActivityBuckets,
  buildChannelChips,
  buildConversationDayGroups,
  clearExcludedChannels,
  filterSessionsForList,
  orderedChannelsForSessions,
  sourceFor,
  toggleExcludedChannel,
} from "./list-model";

interface Props {
  sessions: Session[];
  instances: WebInstance[];
  excludedChannels: ReadonlySet<string>;
  fOut: string;
  fInstance: string;
  setExcludedChannels: (v: ReadonlySet<string>) => void;
  setFOut: (v: string) => void;
  setFInstance: (v: string) => void;
  onOpen: (id: string) => void;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  historyError?: string;
  onLoadOlder: () => void;
}

const label9: Style = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: ".16em",
  color: DIM,
  textTransform: "uppercase",
};

function instanceHealthInfo(instance?: Pick<WebInstance, "health" | "liveConnected">): { label: string; color: string } {
  if (!instance) return { label: "unknown", color: DIM };
  if (instance.liveConnected) return { label: "live", color: "#6FBF8E" };
  const health = instance.health.toLowerCase();
  if (health === "running" || health === "ok") return { label: "running", color: "#6FBF8E" };
  if (health === "stale") return { label: "stale", color: AMBER };
  if (health === "failed" || health === "error" || health === "stopped") return { label: health, color: "#E0685B" };
  return { label: health || "unknown", color: DIM };
}

function compactFailureSummary(session: Session): string | undefined {
  if (!["failed", "cancelled", "interrupted"].includes(session.status)) {
    return undefined;
  }
  const parts = [
    session.failureKind,
    session.error,
    session.failoverHistory !== undefined && session.failoverHistory.length > 0
      ? `${session.failoverHistory.length} provider ${session.failoverHistory.length === 1 ? "attempt" : "attempts"}`
      : undefined,
  ].filter((part): part is string => part !== undefined && part.trim().length > 0);
  return parts.length > 0 ? parts.join(" | ") : session.status;
}

export function ListView(props: Props) {
  const {
    sessions,
    instances: discoveredInstances,
    excludedChannels,
    fOut,
    fInstance,
    setExcludedChannels,
    setFOut,
    setFInstance,
    onOpen,
    canLoadOlder,
    loadingOlder,
    historyError,
    onLoadOlder,
  } = props;
  const [instOpen, setInstOpen] = useState(false);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const excludedChannelKey = [...excludedChannels].sort().join("|");

  useEffect(() => {
    if (!instOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInstOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [instOpen]);

  useEffect(() => {
    setSelectedBucketId(null);
  }, [excludedChannelKey, fOut, fInstance]);

  const m = useMemo(() => {
    const timeZoneBySource = new Map(
      discoveredInstances.map((instance) => [instance.sourceId, instance.timeZone] as const),
    );
    const timeZoneForSession = (session: Session) => timeZoneBySource.get(sourceFor(session));
    // ---- instances (over all sessions) ----
    const instMap: Record<string, { count: number; cwd: string; label: string }> = {};
    sessions.forEach((s) => {
      const key = sourceFor(s);
      if (!instMap[key]) instMap[key] = { count: 0, cwd: s.cwd, label: s.instance };
      instMap[key].count++;
    });
    const instRecords = discoveredInstances.length > 0
      ? [...discoveredInstances]
          .map((inst) => ({ sourceId: inst.sourceId, label: inst.label, cwd: inst.cwd, health: inst.health, liveConnected: inst.liveConnected }))
          .sort((a, b) => a.label.localeCompare(b.label) || a.sourceId.localeCompare(b.sourceId))
      : Object.entries(instMap)
          .map(([sourceId, value]) => ({ sourceId, label: value.label, cwd: value.cwd, health: "unknown", liveConnected: false }))
          .sort((a, b) => a.label.localeCompare(b.label) || a.sourceId.localeCompare(b.sourceId));
    const instances = [
      {
        key: "all",
        label: "All instances",
        count: sessions.length,
        cwd: `${instRecords.length} instance${instRecords.length !== 1 ? "s" : ""} on this machine`,
        healthLabel: "all",
        healthColor: DIMMER,
        active: fInstance === "all",
      },
    ]
      .concat(
        instRecords.map((inst) => {
          const health = instanceHealthInfo(inst);
          return {
            key: inst.sourceId,
            label: inst.label,
            count: instMap[inst.sourceId]?.count ?? 0,
            cwd: inst.cwd,
            healthLabel: health.label,
            healthColor: health.color,
            active: fInstance === inst.sourceId,
          };
        }),
      )
      .map((o) => ({
        key: o.key,
        label: o.label,
        count: o.count,
        cwd: o.cwd,
        healthLabel: o.healthLabel,
        healthColor: o.healthColor,
        bg: o.active ? "rgba(255,255,255,.07)" : "transparent",
        fg: o.active ? TEXT : "#C9CBD1",
        dot: o.key === "all" ? (o.active ? "#6FBF8E" : DIMMER) : o.healthColor,
      }));
    const activeRecord = instRecords.find((inst) => inst.sourceId === fInstance);
    const activeInst = fInstance === "all" ? "All instances" : activeRecord?.label ?? instMap[fInstance]?.label ?? fInstance;
    const activeCount = fInstance === "all" ? sessions.length : instMap[fInstance]?.count || 0;
    const activeTimeZone = fInstance === "all" ? undefined : timeZoneBySource.get(fInstance);

    // ---- filtered set ----
    const baseList = filterSessionsForList(sessions, {
      excludedChannels,
      outcome: fOut,
      instance: fInstance,
    });
    const activity = buildActivityBuckets(baseList, { maxBuckets: activityBucketLimit(isMobile), timeZone: activeTimeZone });
    const selectedBucket = selectedBucketId ? activity.find((bucket) => bucket.id === selectedBucketId) : undefined;
    const list = selectedBucket
      ? filterSessionsForList(sessions, {
          excludedChannels,
          outcome: fOut,
          instance: fInstance,
          selectedBucket,
        })
      : baseList;

    // ---- aggregates over filtered ----
    let cost = 0,
      tok = 0,
      tools = 0,
      think = 0;
    list.forEach((s) => {
      cost += s.totals.cost;
      tok += s.totals.tokIn + s.totals.tokOut;
      tools += s.totals.tcalls;
      think += s.totals.think;
    });
    const n = list.length || 1;
    const dates = list.map((s) => s.startTs).sort();
    const range = dates.length
      ? dateStr(dates[0], activeTimeZone) + " – " + dateStr(dates[dates.length - 1], activeTimeZone)
      : "—";
    const silentN = list.filter((s) => s.outcome === "silent").length;
    const aggTiles = [
      { label: "Total cost", value: fmtCost(cost), sub: "≈ " + fmtCost(cost / n) + " / run", color: AMBER },
      { label: "Tokens", value: fmtTok(tok), sub: "in + out", color: BLUE },
      { label: "Tool calls", value: tools.toLocaleString(), sub: "across all runs", color: TEAL },
      { label: "Reasoning", value: think.toLocaleString(), sub: "thinking blocks", color: VIOLET },
      { label: "Silent runs", value: "" + silentN, sub: "stayed quiet, no interrupt", color: "#8b8d94" },
    ];

    // ---- channel + outcome filter chips ----
    const kindChips = buildChannelChips(sessions, {
      excludedChannels,
      outcome: fOut,
      instance: fInstance,
    });
    const outs: [string, string][] = [
      ["all", "All"],
      ["notified", "Replied"],
      ["silent", "Silent"],
    ];
    const outcomeChips = outs.map(([k, l]) => {
      const active = fOut === k;
      const col = k === "silent" ? "#8b8d94" : k === "notified" ? AMBER : TEXT;
      return {
        key: k,
        label: l,
        active,
        bg: active ? hexA(col, 0.16) : "rgba(255,255,255,.03)",
        border: active ? hexA(col, 0.5) : "rgba(255,255,255,.1)",
        color: active ? col : MUTED,
      };
    });

    // ---- cards ----
    const cards = list.map((s) => {
      const ch = channelOf(s);
      const col = channelColor(ch);
      const isChat = ch === "chat";
      const oi = outcomeInfo(s);
      const zone = timeZoneForSession(s);
      const failureSummary = compactFailureSummary(s);
      return {
        id: s.id,
        key: sessionStoreKey(s),
        timeStr: timeStr(s.startTs, zone),
        dateStr: dateStr(s.startTs, zone),
        dow: dow(s.startTs, zone),
        title: s.title,
        conversationId: s.conversationId,
        accent: col,
        glow: hexA(col, 0.45),
        kindLabel: channelLabel(ch),
        kindBg: hexA(col, 0.12),
        kindBorder: hexA(col, 0.3),
        tools: s.totals.tcalls,
        think: s.totals.think,
        durStr: fmtDur(s.durMs),
        costStr: fmtCost(s.totals.cost),
        showOutcome: !isChat || oi.running || ["failed", "cancelled", "interrupted", "stalled"].includes(s.status),
        outcomeLabel: oi.label,
        outcomeColor: oi.color,
        outcomeBg: hexA(oi.color, 0.12),
        outcomeBorder: hexA(oi.color, 0.32),
        running: oi.running,
        failureSummary,
        segs: segsFor(s),
      };
    });
    const cardsByKey = Object.fromEntries(cards.map((card) => [card.key, card])) as Record<string, (typeof cards)[number]>;
    const groups = buildConversationDayGroups(list, { timeZoneForSession });

    // ---- activity rhythm ----
    const legendKeys = orderedChannelsForSessions(baseList);
    const legend = legendKeys.map((k) => ({ label: channelLabel(k), color: channelColor(k) }));
    const activityReplied = baseList.filter((s) => s.outcome !== "silent").length;
    const activitySilent = baseList.length - activityReplied;
    const activityPeak = activity.length ? Math.max(...activity.map((bucket) => bucket.runCount)) : 0;
    const bucketStatus = selectedBucket
      ? `${list.length} ${list.length === 1 ? "run" : "runs"} in ${selectedBucket.rangeLabel}`
      : `${baseList.length} ${baseList.length === 1 ? "run" : "runs"} across ${activity.length} active ${activity.length === 1 ? "bucket" : "buckets"}`;

    return {
      instances,
      activeInst,
      activeCount,
      range,
      aggTiles,
      kindChips,
      outcomeChips,
      cards,
      cardsByKey,
      groups,
      activity,
      selectedBucket,
      bucketStatus,
      activityReplied,
      activitySilent,
      activityPeak,
      activeTimeZone,
      legend,
      emptyMessage: sessions.length === 0 ? "No runs recorded yet." : "No sessions match this filter.",
    };
  }, [sessions, discoveredInstances, excludedChannels, fOut, fInstance, isMobile, selectedBucketId]);

  const renderProviderTick = (tick: { key: string; label: string }) => (
    <div
      key={tick.key}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        minHeight: 34,
        margin: "2px 0",
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: "#9A90AA",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "rgba(177,138,224,.18)" }} />
      <span
        title={tick.label}
        style={{
          maxWidth: "min(460px, 76vw)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          border: "1px solid rgba(177,138,224,.22)",
          borderRadius: 6,
          padding: "5px 9px",
          background: "rgba(177,138,224,.06)",
        }}
      >
        {tick.label}
      </span>
      <span style={{ flex: 1, height: 1, background: "rgba(177,138,224,.18)" }} />
    </div>
  );

  const renderCard = (card: (typeof m.cards)[number] | undefined) => {
    if (card === undefined) {
      return null;
    }
    return (
      <div
        key={card.key}
        className="rec-card"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(card.key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(card.key);
          }
        }}
        aria-label={`Open run: ${card.title} — ${card.kindLabel}, ${card.dateStr} ${card.timeStr}`}
        style={
          {
            cursor: "pointer",
            position: "relative",
            background: "linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.014))",
            border: "1px solid rgba(255,255,255,.08)",
            borderLeft: `3px solid ${card.accent}`,
            borderRadius: 15,
            padding: isMobile ? "16px 16px" : "17px 20px",
            transition: "transform .16s,border-color .16s,background .16s,box-shadow .16s",
            "--glow": card.glow,
          } as Style
        }
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ minWidth: 58, fontFamily: FONT_MONO }}>
            <div style={{ fontSize: 19, fontWeight: 600, color: TEXT, lineHeight: 1 }}>{card.timeStr}</div>
            <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>
              {card.dow} {card.dateStr}
            </div>
          </div>
          <div style={{ flex: "1 1 220px", minWidth: isMobile ? 0 : 220 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 7 }}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  padding: "3px 8px",
                  borderRadius: 5,
                  background: card.kindBg,
                  color: card.accent,
                  border: `1px solid ${card.kindBorder}`,
                }}
              >
                {card.kindLabel}
              </span>
            </div>
            <div style={{ fontSize: 15.5, color: "#E4E2DB", lineHeight: 1.4, fontWeight: 500, maxWidth: "60ch", overflowWrap: "anywhere", wordBreak: "break-word", textWrap: "pretty" } as Style}>
              {card.title}
            </div>
            {card.failureSummary !== undefined && (
              <div style={{ marginTop: 8, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.45, color: "#E0988F", overflowWrap: "anywhere" }}>
                {card.failureSummary}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 2,
                height: 9,
                marginTop: 13,
                borderRadius: 4,
                overflow: "hidden",
                maxWidth: 380,
                padding: 1,
                background: "rgba(0,0,0,.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,.04)",
              }}
            >
              {card.segs.map((seg, si) => (
                <span key={si} style={{ flex: seg.flex, background: seg.color, borderRadius: 1.5, minWidth: 2 }} />
              ))}
            </div>
          </div>
          <div style={{ minWidth: isMobile ? 0 : 158, flex: isMobile ? "1 1 100%" : "0 0 auto", display: "flex", flexDirection: "column", alignItems: isMobile ? "flex-start" : "flex-end", gap: 12 }}>
            {card.showOutcome && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  padding: "5px 11px",
                  borderRadius: 7,
                  background: card.outcomeBg,
                  color: card.outcomeColor,
                  border: `1px solid ${card.outcomeBorder}`,
                }}
              >
                {card.running && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: card.outcomeColor,
                      boxShadow: `0 0 7px ${card.outcomeColor}`,
                      animation: "rec-blink 1.4s ease-in-out infinite",
                    }}
                  />
                )}
                {card.outcomeLabel}
              </span>
            )}
            <div style={{ display: "flex", gap: 14, alignItems: "center", fontFamily: FONT_MONO, fontSize: 12.5 }}>
              <span title="duration" role="img" aria-label={`Duration ${card.durStr}`} style={{ display: "flex", alignItems: "center", gap: 5, color: "#8b8d94" }}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5v5l3.2 1.8" />
                </svg>
                {card.durStr}
              </span>
              <span title="tool calls" role="img" aria-label={`${card.tools} tool calls`} style={{ display: "flex", alignItems: "center", gap: 5, color: TEAL }}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8.5 6L3.5 12l5 6M15.5 6l5 6-5 6" />
                </svg>
                {card.tools}
              </span>
              <span title="reasoning" role="img" aria-label={`${card.think} reasoning blocks`} style={{ display: "flex", alignItems: "center", gap: 5, color: VIOLET }}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3l1.7 5.6L19 10l-5.3 1.4L12 17l-1.7-5.6L5 10l5.3-1.4z" />
                </svg>
                {card.think}
              </span>
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 16, fontWeight: 600, color: AMBER, letterSpacing: "-.01em" }}>{card.costStr}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* brand + instance picker */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 20,
          flexWrap: "wrap",
          animation: "rec-rise .5s ease both",
          // The rec-rise animation makes this row a stacking context; without a
          // lift, the later session cards paint OVER the (absolutely-positioned)
          // instance dropdown. Raise the whole row above them while it's open.
          position: "relative",
          ...(instOpen ? { zIndex: 60 } : {}),
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "#E0685B",
                boxShadow: "0 0 10px #E0685B",
                animation: "rec-blink 1.8s ease-in-out infinite",
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: ".28em",
                color: MUTED,
                textTransform: "uppercase",
              }}
            >
              Session Recorder
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: "clamp(27px, 8vw, 40px)", lineHeight: 1.02, fontWeight: 600, letterSpacing: "-.02em", maxWidth: "16ch" }}>
            The agent's flight recorder
          </h1>
          <p style={{ margin: "12px 0 0", color: MUTED, fontSize: 15, maxWidth: "52ch", lineHeight: 1.5 }}>
            Every run of your agents — prompt, reasoning, tool calls and cost — captured and laid out to scan fast or dig deep.
          </p>
        </div>

        <div style={{ position: "relative", textAlign: isMobile ? "left" : "right", width: isMobile ? "100%" : undefined, maxWidth: "100%", minWidth: 0 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".18em", color: DIMMER, textTransform: "uppercase", marginBottom: 7 }}>
            Instance
          </div>
          <button
            className="rec-btn"
            onClick={() => setInstOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={instOpen}
            style={{
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02))",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 11,
              padding: "9px 13px",
              minHeight: 44,
              color: TEXT,
              fontFamily: FONT_MONO,
              transition: "border-color .15s",
              maxWidth: "100%",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#6FBF8E",
                boxShadow: "0 0 8px #6FBF8E",
                animation: "rec-blink 2.4s ease-in-out infinite",
              }}
            />
            <span style={{ fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.activeInst}</span>
            <span style={{ fontSize: 11, color: "#8b8d94", background: "rgba(255,255,255,.06)", padding: "2px 7px", borderRadius: 5 }}>
              {m.activeCount}
            </span>
            <span style={{ color: DIM, fontSize: 11 }}>▾</span>
          </button>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: DIMMER, marginTop: 7 }}>{m.range}</div>

          {instOpen && (
            <div
              role="menu"
              aria-label="Instance"
              style={{
                position: "absolute",
                right: 0,
                top: 64,
                zIndex: 50,
                minWidth: 250,
                background: "#15171d",
                border: "1px solid rgba(255,255,255,.14)",
                borderRadius: 13,
                padding: 6,
                boxShadow: "0 24px 60px -16px rgba(0,0,0,.7)",
                textAlign: "left",
                ...(isMobile
                  ? {
                      left: 0,
                      right: "auto",
                      minWidth: 0,
                      width: "min(250px, calc(100vw - 32px))",
                      maxWidth: "calc(100vw - 32px)",
                    }
                  : {}),
              }}
            >
              {m.instances.map((ins) => (
                <button
                  key={ins.key}
                  className="menu-item"
                  role="menuitemradio"
                  aria-checked={ins.key === fInstance}
                  aria-label={`${ins.label}, ${ins.count} runs, ${ins.healthLabel}`}
                  onClick={() => {
                    setFInstance(ins.key);
                    setInstOpen(false);
                  }}
                  style={{
                    cursor: "pointer",
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 44,
                    background: ins.bg,
                    border: "none",
                    borderRadius: 9,
                    padding: "10px 11px",
                    textAlign: "left",
                  }}
                >
                  <span title={ins.healthLabel} style={{ width: 7, height: 7, borderRadius: "50%", background: ins.dot, flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: FONT_UI, fontSize: 14, fontWeight: 600, color: ins.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ins.label}</span>
                    <span
                      style={{
                        display: "block",
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        color: DIM,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {ins.cwd}
                    </span>
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: "#8b8d94" }}>{ins.count}</span>
                  {ins.key !== "all" && (
                    <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: ins.healthColor, textTransform: "uppercase", whiteSpace: "nowrap" }}>{ins.healthLabel}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* aggregate tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 28 }}>
        {m.aggTiles.map((t) => (
          <div
            key={t.label}
            style={{
              background: "linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012))",
              border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 15,
              padding: "15px 17px",
            }}
          >
            <div style={{ width: 20, height: 3, borderRadius: 2, background: t.color, marginBottom: 12, boxShadow: `0 0 10px ${t.color}` }} />
            <div style={label9}>{t.label}</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 29, fontWeight: 600, marginTop: 7, letterSpacing: "-.02em", color: t.color }}>
              {t.value}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{t.sub}</div>
          </div>
        ))}
      </div>

      {/* activity rhythm */}
      <div
        style={{
          marginTop: 16,
          background: "linear-gradient(180deg,rgba(255,255,255,.032),rgba(255,255,255,.006))",
          border: "1px solid rgba(255,255,255,.08)",
          borderRadius: 16,
          padding: isMobile ? "16px 14px 18px" : "18px 22px 20px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={label9}>Activity rhythm</div>
            <div style={{ marginTop: 6, fontFamily: FONT_MONO, fontSize: 11, color: DIM, lineHeight: 1.45 }}>
              {m.bucketStatus}
              {m.activityPeak > 0 ? ` · peak ${m.activityPeak}` : ""}
            </div>
          </div>
          {m.selectedBucket && (
            <button
              className="rec-btn"
              type="button"
              onClick={() => setSelectedBucketId(null)}
              style={{
                cursor: "pointer",
                minHeight: 38,
                borderRadius: 9,
                border: "1px solid rgba(255,255,255,.12)",
                background: "rgba(255,255,255,.045)",
                color: "#C9CBD1",
                fontFamily: FONT_MONO,
                fontSize: 11,
                padding: "8px 11px",
              }}
            >
              Clear bucket
            </button>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 15 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { label: "Runs", value: String(m.activity.reduce((sum, bucket) => sum + bucket.runCount, 0)), color: TEXT },
              { label: "Replied", value: String(m.activityReplied), color: AMBER },
              { label: "Silent", value: String(m.activitySilent), color: "#8b8d94" },
            ].map((item) => (
              <span
                key={item.label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  minHeight: 30,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,.08)",
                  background: "rgba(255,255,255,.03)",
                  padding: "5px 9px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: DIM,
                }}
              >
                <span style={{ color: item.color, fontWeight: 700 }}>{item.value}</span>
                {item.label}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            {m.legend.map((lg) => (
              <span key={lg.label} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_MONO, fontSize: 11, color: MUTED }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: lg.color }} />
                {lg.label}
              </span>
            ))}
          </div>
        </div>

        {m.activity.length > 0 ? isMobile ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {m.activity.map((bucket) => {
              const selected = m.selectedBucket?.id === bucket.id;
              const intensityWidth = Math.max(12, bucket.intensityPct);
              return (
                <button
                  key={bucket.id}
                  className="rec-btn"
                  type="button"
                  aria-pressed={selected}
                  aria-label={bucket.ariaLabel}
                  title={bucket.title}
                  onClick={() => setSelectedBucketId(selected ? null : bucket.id)}
                  style={{
                    cursor: "pointer",
                    width: "100%",
                    minHeight: 76,
                    borderRadius: 10,
                    border: `1px solid ${selected ? hexA(bucket.dominantColor, 0.72) : "rgba(255,255,255,.1)"}`,
                    background: selected ? hexA(bucket.dominantColor, 0.14) : "rgba(255,255,255,.026)",
                    color: TEXT,
                    padding: "10px 11px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    gap: 8,
                    boxShadow: selected ? `0 0 0 1px ${hexA(bucket.dominantColor, 0.2)}` : "none",
                    textAlign: "left",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: TEXT, lineHeight: 1, flex: "none" }}>{bucket.runCount}</span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: bucket.dominantColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {bucket.dominantLabel}
                    </span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DIM, marginLeft: "auto", whiteSpace: "nowrap" }}>{timeStr(bucket.startMs, m.activeTimeZone)}</span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: AMBER, whiteSpace: "nowrap" }}>{bucket.costLabel}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      height: 13,
                      borderRadius: 999,
                      background: "rgba(0,0,0,.24)",
                      border: "1px solid rgba(255,255,255,.07)",
                      overflow: "hidden",
                      display: "flex",
                    }}
                  >
                    <span
                      style={{
                        width: `${intensityWidth}%`,
                        minWidth: 24,
                        maxWidth: "100%",
                        display: "flex",
                        borderRadius: 999,
                        overflow: "hidden",
                        boxShadow: `0 0 12px ${hexA(bucket.dominantColor, 0.18)}`,
                      }}
                    >
                      {bucket.channelSegments.map((segment) => (
                        <span key={segment.key} style={{ flex: `${segment.pct} 1 0`, minWidth: 3, background: segment.color }} />
                      ))}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, fontFamily: FONT_MONO, fontSize: 10, color: DIM }}>
                    <span style={{ whiteSpace: "nowrap" }}>{bucket.repliedCount} replied</span>
                    <span style={{ whiteSpace: "nowrap" }}>{bucket.silentCount} silent</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{bucket.rangeLabel}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ overflowX: "auto", overflowY: "hidden", paddingBottom: 3, margin: isMobile ? "0 -4px" : 0, maxWidth: "100%" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${m.activity.length}, minmax(48px, 1fr))`,
                gap: 8,
                minWidth: 0,
              }}
            >
              {m.activity.map((bucket) => {
                const selected = m.selectedBucket?.id === bucket.id;
                const barHeight = Math.max(14, Math.round(bucket.intensityPct * 0.58));
                return (
                  <button
                    key={bucket.id}
                    className="rec-btn"
                    type="button"
                    aria-pressed={selected}
                    aria-label={bucket.ariaLabel}
                    title={bucket.title}
                    onClick={() => setSelectedBucketId(selected ? null : bucket.id)}
                    style={{
                      cursor: "pointer",
                      minHeight: 128,
                      borderRadius: 10,
                      border: `1px solid ${selected ? hexA(bucket.dominantColor, 0.72) : "rgba(255,255,255,.1)"}`,
                      background: selected ? hexA(bucket.dominantColor, 0.14) : "rgba(255,255,255,.026)",
                      color: TEXT,
                      padding: "9px 8px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "stretch",
                      gap: 7,
                      boxShadow: selected ? `0 0 0 1px ${hexA(bucket.dominantColor, 0.2)}, 0 12px 30px -22px ${bucket.dominantColor}` : "none",
                    }}
                  >
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 5, minWidth: 0 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 17, fontWeight: 700, color: TEXT, lineHeight: 1 }}>{bucket.runCount}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{timeStr(bucket.startMs, m.activeTimeZone)}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      style={{
                        flex: 1,
                        minHeight: 58,
                        display: "flex",
                        alignItems: "flex-end",
                        justifyContent: "center",
                        borderRadius: 8,
                        background: "rgba(0,0,0,.22)",
                        padding: "7px 5px",
                      }}
                    >
                      <span
                        style={{
                          width: "100%",
                          height: `${barHeight}%`,
                          minHeight: 12,
                          borderRadius: 6,
                          overflow: "hidden",
                          border: `1px solid ${hexA(bucket.dominantColor, 0.48)}`,
                          display: "flex",
                          flexDirection: "column-reverse",
                          boxShadow: `0 0 14px ${hexA(bucket.dominantColor, 0.22)}`,
                        }}
                      >
                        {bucket.channelSegments.map((segment) => (
                          <span key={segment.key} style={{ flex: `${segment.pct} 1 0`, minHeight: 3, background: segment.color }} />
                        ))}
                      </span>
                    </span>
                    <span aria-hidden="true" style={{ display: "flex", height: 4, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,.06)" }}>
                      <span style={{ width: `${(bucket.repliedCount / bucket.runCount) * 100}%`, background: AMBER }} />
                      <span style={{ width: `${(bucket.silentCount / bucket.runCount) * 100}%`, background: "#8b8d94" }} />
                    </span>
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 5, minWidth: 0 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: bucket.dominantColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {bucket.dominantLabel}
                      </span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: AMBER, flex: "none" }}>{bucket.costLabel}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ border: "1px dashed rgba(255,255,255,.1)", borderRadius: 10, padding: "18px 14px", color: DIM, fontFamily: FONT_MONO, fontSize: 12 }}>
            No activity in this filter.
          </div>
        )}
      </div>

      {/* filters */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 26, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {m.kindChips.map((c) => (
            <button
              key={c.key}
              className="rec-chip"
              aria-pressed={c.active}
              onClick={() => {
                setSelectedBucketId(null);
                setExcludedChannels(c.key === "all" ? clearExcludedChannels() : toggleExcludedChannel(excludedChannels, c.key));
              }}
              style={{
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                padding: "9px 14px",
                borderRadius: 999,
                border: `1px solid ${c.border}`,
                background: c.bg,
                color: c.color,
              }}
            >
              {c.label}
              <span style={{ opacity: 0.55, marginLeft: 6 }}>{c.n}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", ...(isMobile ? {} : { marginLeft: "auto" }) }}>
          {m.outcomeChips.map((c) => (
            <button
              key={c.key}
              className="rec-chip"
              aria-pressed={c.active}
              onClick={() => setFOut(c.key)}
              style={{
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                padding: "9px 14px",
                borderRadius: 999,
                border: `1px solid ${c.border}`,
                background: c.bg,
                color: c.color,
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* session cards */}
      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 18 }}>
        {m.groups.map((group) => (
          <section key={group.key} aria-label={group.label} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: ".18em",
                textTransform: "uppercase",
                color: DIM,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,.08)" }} />
              <span style={{ whiteSpace: "nowrap" }}>{group.label}</span>
              <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,.08)" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {group.lanes.map((lane) => (
                <div key={lane.key} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(112px, 168px) minmax(0, 1fr)", gap: isMobile ? 7 : 12, alignItems: "start" }}>
                  <div
                    title={lane.label}
                    style={{
                      position: isMobile ? "static" : "sticky",
                      top: 76,
                      minWidth: 0,
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      lineHeight: 1.4,
                      color: "#8b8d94",
                      border: "1px solid rgba(255,255,255,.07)",
                      borderRadius: 8,
                      padding: isMobile ? "6px 8px" : "8px 9px",
                      background: "rgba(255,255,255,.025)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {lane.label}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {lane.items.map((item) =>
                      item.type === "tick"
                        ? renderProviderTick(item.tick)
                        : renderCard(m.cardsByKey[sessionStoreKey(item.session)]),
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {historyError !== undefined && (
        <div role="alert" style={{ marginTop: 16, border: "1px solid rgba(224,104,91,.28)", borderRadius: 10, padding: "12px 13px", background: "rgba(224,104,91,.07)", color: "#E0988F", fontFamily: FONT_MONO, fontSize: 12, overflowWrap: "anywhere" }}>
          {historyError}
        </div>
      )}

      {(canLoadOlder || loadingOlder) && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 22 }}>
          <button
            className="rec-btn"
            type="button"
            disabled={loadingOlder}
            onClick={onLoadOlder}
            style={{
              cursor: loadingOlder ? "wait" : "pointer",
              minHeight: 44,
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,.14)",
              background: loadingOlder ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.055)",
              color: loadingOlder ? DIM : "#C9CBD1",
              fontFamily: FONT_MONO,
              fontSize: 12,
              padding: "10px 14px",
            }}
          >
            {loadingOlder ? "Loading older" : "Load older"}
          </button>
        </div>
      )}

      {m.cards.length === 0 && (
        <div style={{ textAlign: "center", color: DIM, padding: 50, fontFamily: FONT_MONO, fontSize: 13 }}>
          {canLoadOlder ? "No loaded sessions match this filter." : m.emptyMessage}
        </div>
      )}

      {instOpen && <div onClick={() => setInstOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />}
    </>
  );
}
