import { useMemo } from "react";
import type { Session, WebInstance } from "../lib/types";
import { dateStr, timeStr, fmtCost, fmtTok, channelOf, channelColor, channelLabel } from "../lib/format";
import { FONT_MONO, TEXT, MUTED, DIM, AMBER, BLUE, TEAL, VIOLET, CHANNEL_ORDER } from "../lib/tokens";

interface Props {
  instances: WebInstance[];
  sessions: Session[];
  onOpenInstance: (sourceId: string) => void;
}

const chOrder = CHANNEL_ORDER;

export interface InstanceCard {
  sourceId: string;
  name: string;
  cwd: string;
  count: number;
  health: string;
  liveConnected: boolean;
  healthLabel: string;
  healthColor: string;
  stats: { label: string; value: string; color: string }[];
  chSegs: { label: string; color: string; n: number; w: number }[];
  noti: number;
  sil: number;
  last: string;
}

function healthInfo(instance: Pick<WebInstance, "health" | "liveConnected">): { label: string; color: string } {
  if (instance.liveConnected) {
    return { label: "live", color: "#6FBF8E" };
  }
  const health = instance.health.toLowerCase();
  if (health === "running" || health === "ok") {
    return { label: "running", color: "#6FBF8E" };
  }
  if (health === "stale") {
    return { label: "stale", color: AMBER };
  }
  if (health === "failed" || health === "error" || health === "stopped") {
    return { label: health, color: "#E0685B" };
  }
  return { label: health || "unknown", color: DIM };
}

export function buildInstanceCards(instances: readonly WebInstance[], sessions: readonly Session[]): InstanceCard[] {
  const sessionsBySource = new Map<string, Session[]>();
  for (const session of sessions) {
    const sourceId = session.sourceId ?? session.instance;
    const arr = sessionsBySource.get(sourceId) ?? [];
    arr.push(session);
    sessionsBySource.set(sourceId, arr);
  }

  const instanceRecords = instances.length > 0
    ? instances
    : [...sessionsBySource.entries()].map(([sourceId, arr]) => ({
        sourceId,
        label: arr[0]?.instance ?? sourceId,
        cwd: arr[0]?.cwd ?? "",
        artifactDir: "",
        health: "unknown",
        liveConnected: false,
        counts: { runs: arr.length },
      }));

  return [...instanceRecords]
    .sort((a, b) => a.label.localeCompare(b.label) || a.sourceId.localeCompare(b.sourceId))
    .map((instance) => {
      const arr = sessionsBySource.get(instance.sourceId) ?? [];
      let cost = 0,
        tok = 0,
        tools = 0,
        think = 0,
        sil = 0,
        noti = 0;
      const chCount: Record<string, number> = {};
      arr.forEach((s) => {
        cost += s.totals.cost;
        tok += s.totals.tokIn + s.totals.tokOut;
        tools += s.totals.tcalls;
        think += s.totals.think;
        if (s.outcome === "silent") sil++;
        else noti++;
        const ch = channelOf(s);
        chCount[ch] = (chCount[ch] || 0) + 1;
      });
      const times = arr.map((s) => +new Date(s.startTs));
      const last = times.length > 0 ? Math.max(...times) : undefined;
      const health = healthInfo(instance);
      const chSegs = chOrder
        .filter((c) => chCount[c])
        .map((c) => ({
          label: channelLabel(c),
          color: channelColor(c),
          n: chCount[c],
          w: Math.round((chCount[c] / Math.max(1, arr.length)) * 100),
        }));
      return {
        sourceId: instance.sourceId,
        name: instance.label,
        cwd: instance.cwd,
        count: arr.length,
        health: instance.health,
        liveConnected: instance.liveConnected,
        healthLabel: health.label,
        healthColor: health.color,
        stats: [
          { label: "Cost", value: fmtCost(cost), color: AMBER },
          { label: "Tokens", value: fmtTok(tok), color: BLUE },
          { label: "Tool calls", value: "" + tools, color: TEAL },
          { label: "Reasoning", value: "" + think, color: VIOLET },
        ],
        chSegs,
        noti,
        sil,
        last: last === undefined ? "no runs" : dateStr(last) + " · " + timeStr(last),
      };
    });
}

export function InstancesView({ instances, sessions, onOpenInstance }: Props) {
  const cards = useMemo(() => buildInstanceCards(instances, sessions), [instances, sessions]);

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "#6FBF8E",
              boxShadow: "0 0 10px #6FBF8E",
              animation: "rec-blink 2.4s ease-in-out infinite",
              display: "inline-block",
            }}
          />
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: ".28em", color: MUTED, textTransform: "uppercase" }}>Instances</span>
        </div>
        <h1 style={{ margin: 0, color: TEXT, fontSize: "clamp(26px, 7vw, 36px)", lineHeight: 1.04, fontWeight: 600, letterSpacing: "-.02em" }}>Agents on this machine</h1>
        <p style={{ margin: "11px 0 0", color: MUTED, fontSize: 15, lineHeight: 1.45, maxWidth: "48ch" }}>
          {cards.length} agent instance{cards.length !== 1 ? "s" : ""} recording sessions — open one to dig into its runs.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(330px, 100%),1fr))", gap: 14 }}>
        {cards.map((ic) => (
          <div
            key={ic.sourceId}
            className="inst-card"
            role="button"
            tabIndex={0}
            aria-label={`Open instance ${ic.name}: ${ic.count} runs, ${ic.healthLabel}`}
            onClick={() => onOpenInstance(ic.sourceId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenInstance(ic.sourceId);
              }
            }}
            style={{
              cursor: "pointer",
              background: "linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.014))",
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 16,
              padding: 20,
              transition: "transform .16s,border-color .16s,box-shadow .16s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 6 }}>
              <span
                title={ic.healthLabel}
                aria-label={ic.healthLabel}
                style={{ width: 10, height: 10, borderRadius: "50%", background: ic.healthColor, boxShadow: `0 0 10px ${ic.healthColor}`, flex: "none" }}
              />
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: TEXT,
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ic.name}
              </span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: "#C9CBD1", background: "rgba(255,255,255,.06)", padding: "3px 9px", borderRadius: 6 }}>
                {ic.count} runs
              </span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  color: ic.healthColor,
                  background: "rgba(255,255,255,.04)",
                  border: `1px solid ${ic.healthColor}55`,
                  padding: "3px 7px",
                  borderRadius: 6,
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {ic.healthLabel}
              </span>
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: DIM,
                marginBottom: 17,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {ic.cwd}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 10, marginBottom: 17 }}>
              {ic.stats.map((st) => (
                <div key={st.label}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".1em", color: DIM, textTransform: "uppercase" }}>{st.label}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: "clamp(16px, 4.6vw, 18px)", fontWeight: 600, marginTop: 4, color: st.color }}>{st.value}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", height: 8, borderRadius: 5, overflow: "hidden", background: "rgba(255,255,255,.05)", marginBottom: 10 }}>
              {ic.chSegs.map((cs) => (
                <div key={cs.label} title={cs.label} style={{ width: `${cs.w}%`, background: cs.color }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 13, flexWrap: "wrap" }}>
              {ic.chSegs.map((cs) => (
                <span key={cs.label} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_MONO, fontSize: 11, color: MUTED }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: cs.color }} />
                  {cs.label} {cs.n}
                </span>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "4px 12px",
                marginTop: 14,
                paddingTop: 13,
                borderTop: "1px solid rgba(255,255,255,.07)",
                fontFamily: FONT_MONO,
                fontSize: 11,
              }}
            >
              <span style={{ color: MUTED, whiteSpace: "nowrap" }}>
                <span style={{ color: AMBER }}>{ic.noti}</span> notified · <span style={{ color: "#8b8d94" }}>{ic.sil}</span> silent
              </span>
              <span style={{ color: DIM, whiteSpace: "nowrap" }}>last {ic.last}</span>
            </div>
          </div>
        ))}
      </div>

      {cards.length === 0 && (
        <div style={{ textAlign: "center", color: DIM, padding: 50, fontFamily: FONT_MONO, fontSize: 13 }}>
          No instances discovered yet.
        </div>
      )}
    </>
  );
}
