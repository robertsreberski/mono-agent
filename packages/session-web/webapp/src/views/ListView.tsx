import { useMemo, useState } from "react";
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
  tz,
} from "../lib/format";
import { FONT_MONO, FONT_UI, TEXT, MUTED, DIM, DIMMER, AMBER, BLUE, TEAL, VIOLET, type Style } from "../lib/tokens";

interface Props {
  sessions: Session[];
  instances: WebInstance[];
  fChannel: string;
  fOut: string;
  fInstance: string;
  setFChannel: (v: string) => void;
  setFOut: (v: string) => void;
  setFInstance: (v: string) => void;
  onOpen: (id: string) => void;
}

const label9: Style = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: ".16em",
  color: DIM,
  textTransform: "uppercase",
};

export function ListView(props: Props) {
  const { sessions, fChannel, fOut, fInstance, setFChannel, setFOut, setFInstance, onOpen } = props;
  const [instOpen, setInstOpen] = useState(false);

  const m = useMemo(() => {
    // ---- instances (over all sessions) ----
    const instMap: Record<string, { count: number; cwd: string }> = {};
    sessions.forEach((s) => {
      if (!instMap[s.instance]) instMap[s.instance] = { count: 0, cwd: s.cwd };
      instMap[s.instance].count++;
    });
    const instNames = Object.keys(instMap).sort();
    const instances = [
      {
        key: "all",
        label: "All instances",
        count: sessions.length,
        cwd: `${instNames.length} instance${instNames.length !== 1 ? "s" : ""} on this machine`,
        active: fInstance === "all",
      },
    ]
      .concat(
        instNames.map((nm) => ({
          key: nm,
          label: nm,
          count: instMap[nm].count,
          cwd: instMap[nm].cwd,
          active: fInstance === nm,
        })),
      )
      .map((o) => ({
        key: o.key,
        label: o.label,
        count: o.count,
        cwd: o.cwd,
        bg: o.active ? "rgba(255,255,255,.07)" : "transparent",
        fg: o.active ? TEXT : "#C9CBD1",
        dot: o.active ? "#6FBF8E" : DIMMER,
      }));
    const activeInst = fInstance === "all" ? "All instances" : fInstance;
    const activeCount = fInstance === "all" ? sessions.length : instMap[fInstance]?.count || 0;

    // ---- filtered set ----
    const list = sessions.filter(
      (s) =>
        (fChannel === "all" || channelOf(s) === fChannel) &&
        (fOut === "all" || s.outcome === fOut) &&
        (fInstance === "all" || s.instance === fInstance),
    );

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
    const range = dates.length ? dateStr(dates[0]) + " – " + dateStr(dates[dates.length - 1]) : "—";
    const silentN = list.filter((s) => s.outcome === "silent").length;
    const aggTiles = [
      { label: "Total cost", value: fmtCost(cost), sub: "≈ " + fmtCost(cost / n) + " / run", color: AMBER },
      { label: "Tokens", value: fmtTok(tok), sub: "in + out", color: BLUE },
      { label: "Tool calls", value: "" + tools, sub: "across all runs", color: TEAL },
      { label: "Reasoning", value: "" + think, sub: "thinking blocks", color: VIOLET },
      { label: "Silent runs", value: "" + silentN, sub: "stayed quiet, no interrupt", color: "#8b8d94" },
    ];

    // ---- channel + outcome filter chips ----
    const chOrder = ["memory", "webhook", "chat", "cron"];
    const present = chOrder.filter((c) => sessions.some((s) => channelOf(s) === c));
    const chKeys = ["all", ...present];
    const kindChips = chKeys.map((k) => {
      const active = fChannel === k;
      const col = k === "all" ? TEXT : channelColor(k);
      const nn = k === "all" ? sessions.length : sessions.filter((s) => channelOf(s) === k).length;
      return {
        key: k,
        label: k === "all" ? "All" : channelLabel(k),
        n: nn,
        bg: active ? (k === "all" ? "rgba(255,255,255,.14)" : hexA(col, 0.16)) : "rgba(255,255,255,.03)",
        border: active ? hexA(col, 0.5) : "rgba(255,255,255,.1)",
        color: active ? col : MUTED,
      };
    });
    const outs: [string, string][] = [
      ["all", "All"],
      ["notified", "Notified"],
      ["silent", "Silent"],
    ];
    const outcomeChips = outs.map(([k, l]) => {
      const active = fOut === k;
      const col = k === "silent" ? "#8b8d94" : k === "notified" ? AMBER : TEXT;
      return {
        key: k,
        label: l,
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
      return {
        id: s.id,
        timeStr: timeStr(s.startTs),
        dateStr: dateStr(s.startTs),
        dow: dow(s.startTs),
        title: s.title,
        accent: col,
        glow: hexA(col, 0.45),
        kindLabel: channelLabel(ch),
        kindBg: hexA(col, 0.12),
        kindBorder: hexA(col, 0.3),
        tools: s.totals.tcalls,
        think: s.totals.think,
        durStr: fmtDur(s.durMs),
        costStr: fmtCost(s.totals.cost),
        showOutcome: !isChat || oi.running,
        outcomeLabel: oi.label,
        outcomeColor: oi.color,
        outcomeBg: hexA(oi.color, 0.12),
        outcomeBorder: hexA(oi.color, 0.32),
        running: oi.running,
        segs: segsFor(s),
      };
    });

    // ---- activity timeline ----
    const times = list.map((s) => +new Date(s.startTs));
    const amin = times.length ? Math.min(...times) : 0;
    const amax = times.length ? Math.max(...times) : 1;
    const span = Math.max(1, amax - amin);
    const maxC = Math.max(...[0.001, ...list.map((s) => s.totals.cost)]);
    const activity = list.map((s) => {
      const ch = channelOf(s);
      const x = ((+new Date(s.startTs) - amin) / span) * 100;
      const cn = s.totals.cost / maxC;
      const c = channelColor(ch);
      const sil = s.outcome === "silent";
      return {
        id: s.id,
        left: x,
        h: Math.round(12 + cn * 52),
        color: c,
        fill: sil ? "transparent" : c,
        tip:
          channelLabel(ch) +
          " · " +
          dateStr(s.startTs) +
          " " +
          timeStr(s.startTs) +
          " · " +
          fmtCost(s.totals.cost) +
          (sil ? " · silent" : " · notified"),
      };
    });
    const dayMs = 86400000;
    const dayTicks: { left: number; label: string }[] = [];
    const d0 = new Date(amin);
    d0.setUTCHours(0, 0, 0, 0);
    for (let t = +d0; t <= amax + dayMs; t += dayMs) {
      const x = ((t - amin) / span) * 100;
      if (x < -3 || x > 103) continue;
      dayTicks.push({ left: Math.max(0, Math.min(100, x)), label: tz(t, { day: "2-digit" }) });
    }
    const legend = present.map((k) => ({ label: channelLabel(k), color: channelColor(k) }));

    // ---- cumulative spend ----
    const sorted = [...list].sort((a, b) => +new Date(a.startTs) - +new Date(b.startTs));
    const totC = sorted.reduce((a, x) => a + x.totals.cost, 0) || 0.0001;
    let cc = 0;
    const pts = sorted.map((s) => {
      cc += s.totals.cost;
      return { x: ((+new Date(s.startTs) - amin) / span) * 100, y: (cc / totC) * 100 };
    });
    let costChart: {
      has: boolean;
      line?: string;
      area?: string;
      total?: string;
      startLabel?: string;
      endLabel?: string;
      gridY?: number[];
    } = { has: false };
    if (pts.length > 1) {
      let line = "M " + pts[0].x.toFixed(2) + " " + (100 - pts[0].y).toFixed(2);
      for (let i = 1; i < pts.length; i++) line += " L " + pts[i].x.toFixed(2) + " " + (100 - pts[i].y).toFixed(2);
      const area = line + " L " + pts[pts.length - 1].x.toFixed(2) + " 100 L " + pts[0].x.toFixed(2) + " 100 Z";
      costChart = {
        has: true,
        line,
        area,
        total: fmtCost(totC),
        startLabel: dateStr(sorted[0].startTs),
        endLabel: dateStr(sorted[sorted.length - 1].startTs),
        gridY: [25, 50, 75],
      };
    }

    return {
      instances,
      activeInst,
      activeCount,
      range,
      aggTiles,
      kindChips,
      outcomeChips,
      cards,
      activity,
      dayTicks,
      legend,
      costChart,
    };
  }, [sessions, fChannel, fOut, fInstance]);

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
          <h1 style={{ margin: 0, fontSize: 40, lineHeight: 1.02, fontWeight: 600, letterSpacing: "-.02em", maxWidth: "16ch" }}>
            The agent's flight recorder
          </h1>
          <p style={{ margin: "12px 0 0", color: MUTED, fontSize: 15, maxWidth: "52ch", lineHeight: 1.5 }}>
            Every run of your agents — prompt, reasoning, tool calls and cost — captured and laid out to scan fast or dig deep.
          </p>
        </div>

        <div style={{ position: "relative", textAlign: "right" }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".18em", color: DIMMER, textTransform: "uppercase", marginBottom: 7 }}>
            Instance
          </div>
          <button
            className="rec-btn"
            onClick={() => setInstOpen((o) => !o)}
            style={{
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02))",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 11,
              padding: "9px 13px",
              color: TEXT,
              fontFamily: FONT_MONO,
              transition: "border-color .15s",
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
            <span style={{ fontSize: 14, fontWeight: 600 }}>{m.activeInst}</span>
            <span style={{ fontSize: 11, color: "#8b8d94", background: "rgba(255,255,255,.06)", padding: "2px 7px", borderRadius: 5 }}>
              {m.activeCount}
            </span>
            <span style={{ color: DIM, fontSize: 11 }}>▾</span>
          </button>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: DIMMER, marginTop: 7 }}>{m.range}</div>

          {instOpen && (
            <div
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
              }}
            >
              {m.instances.map((ins) => (
                <button
                  key={ins.key}
                  className="menu-item"
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
                    background: ins.bg,
                    border: "none",
                    borderRadius: 9,
                    padding: "10px 11px",
                    textAlign: "left",
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: ins.dot, flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: FONT_UI, fontSize: 14, fontWeight: 600, color: ins.fg }}>{ins.label}</span>
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

      {/* activity timeline */}
      <div
        style={{
          marginTop: 16,
          background: "linear-gradient(180deg,rgba(255,255,255,.032),rgba(255,255,255,.006))",
          border: "1px solid rgba(255,255,255,.08)",
          borderRadius: 16,
          padding: "18px 22px 30px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <span style={label9}>Activity &nbsp;·&nbsp; height = cost &nbsp;·&nbsp; hollow = stayed silent</span>
          <div style={{ display: "flex", gap: 15, flexWrap: "wrap", alignItems: "center" }}>
            {m.legend.map((lg) => (
              <span key={lg.label} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT_MONO, fontSize: 11, color: MUTED }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: lg.color }} />
                {lg.label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ position: "relative", height: 78 }}>
          {m.dayTicks.map((tk, i) => (
            <div key={i}>
              <div style={{ position: "absolute", top: 0, bottom: 14, left: `${tk.left}%`, width: 1, background: "rgba(255,255,255,.045)" }} />
              <div
                style={{
                  position: "absolute",
                  bottom: -6,
                  left: `${tk.left}%`,
                  transform: "translateX(-50%)",
                  fontFamily: FONT_MONO,
                  fontSize: 9,
                  color: DIMMER,
                }}
              >
                {tk.label}
              </div>
            </div>
          ))}
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, height: 1, background: "rgba(255,255,255,.1)" }} />
          {m.activity.map((a, i) => (
            <div
              key={a.id + i}
              className="rec-bar"
              onClick={() => onOpen(a.id)}
              title={a.tip}
              style={
                {
                  position: "absolute",
                  bottom: 14,
                  left: `${a.left}%`,
                  width: 8,
                  height: a.h,
                  borderRadius: 3,
                  background: a.fill,
                  border: `1.5px solid ${a.color}`,
                  cursor: "pointer",
                  "--color": a.color,
                } as Style
              }
            />
          ))}
        </div>
      </div>

      {/* cumulative spend */}
      {m.costChart.has && (
        <div
          style={{
            marginTop: 12,
            background: "linear-gradient(180deg,rgba(255,255,255,.032),rgba(255,255,255,.006))",
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: 16,
            padding: "18px 22px 14px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <span style={label9}>Cumulative spend over time</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: AMBER, fontWeight: 600 }}>{m.costChart.total} total</span>
          </div>
          <div style={{ position: "relative", height: 132 }}>
            {m.costChart.gridY!.map((gy) => (
              <div key={gy} style={{ position: "absolute", left: 0, right: 0, top: `${gy}%`, height: 1, background: "rgba(255,255,255,.04)" }} />
            ))}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}>
              <defs>
                <linearGradient id="cgspend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={AMBER} stopOpacity="0.34" />
                  <stop offset="1" stopColor={AMBER} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={m.costChart.area} fill="url(#cgspend)" />
              <path d={m.costChart.line} fill="none" stroke={AMBER} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: FONT_MONO, fontSize: 10, color: DIMMER }}>
            <span>{m.costChart.startLabel}</span>
            <span>{m.costChart.endLabel}</span>
          </div>
        </div>
      )}

      {/* filters */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 26, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {m.kindChips.map((c) => (
            <button
              key={c.key}
              className="rec-chip"
              onClick={() => setFChannel(c.key)}
              style={{
                cursor: "pointer",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                padding: "7px 13px",
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
        <div style={{ display: "flex", gap: 7, marginLeft: "auto" }}>
          {m.outcomeChips.map((c) => (
            <button
              key={c.key}
              className="rec-chip"
              onClick={() => setFOut(c.key)}
              style={{
                cursor: "pointer",
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                padding: "7px 13px",
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
      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 11 }}>
        {m.cards.map((card) => (
          <div
            key={card.id}
            className="rec-card"
            onClick={() => onOpen(card.id)}
            style={
              {
                cursor: "pointer",
                position: "relative",
                background: "linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.014))",
                border: "1px solid rgba(255,255,255,.08)",
                borderLeft: `3px solid ${card.accent}`,
                borderRadius: 15,
                padding: "17px 20px",
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
              <div style={{ flex: 1, minWidth: 220 }}>
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
                <div style={{ fontSize: 15.5, color: "#E4E2DB", lineHeight: 1.4, fontWeight: 500, maxWidth: "60ch", textWrap: "pretty" } as Style}>
                  {card.title}
                </div>
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
              <div style={{ minWidth: 158, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
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
                  <span title="duration" style={{ display: "flex", alignItems: "center", gap: 5, color: "#8b8d94" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7.5v5l3.2 1.8" />
                    </svg>
                    {card.durStr}
                  </span>
                  <span title="tool calls" style={{ display: "flex", alignItems: "center", gap: 5, color: TEAL }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 6L3.5 12l5 6M15.5 6l5 6-5 6" />
                    </svg>
                    {card.tools}
                  </span>
                  <span title="reasoning" style={{ display: "flex", alignItems: "center", gap: 5, color: VIOLET }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3l1.7 5.6L19 10l-5.3 1.4L12 17l-1.7-5.6L5 10l5.3-1.4z" />
                    </svg>
                    {card.think}
                  </span>
                </div>
                <span style={{ fontFamily: FONT_MONO, fontSize: 16, fontWeight: 600, color: AMBER, letterSpacing: "-.01em" }}>{card.costStr}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {m.cards.length === 0 && (
        <div style={{ textAlign: "center", color: DIM, padding: 50, fontFamily: FONT_MONO, fontSize: 13 }}>No sessions match this filter.</div>
      )}

      {instOpen && <div onClick={() => setInstOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />}
    </>
  );
}
