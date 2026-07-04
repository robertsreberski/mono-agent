import { useMemo, useState } from "react";
import { useRecorder } from "../lib/store";
import type { SessionStep } from "../lib/types";
import { Markdown } from "../lib/markdown";
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
  outcomeInfo,
  effortInfo,
} from "../lib/format";
import { FONT_MONO, FONT_UI, FONT_SERIF, TEXT, MUTED, DIM, DIMMER, AMBER, BLUE, TEAL, VIOLET, OK, ERROR } from "../lib/tokens";
import { useIsMobile } from "../lib/useIsMobile";

interface Props {
  id: string;
  onBack: () => void;
}

const TOOL_PALETTE = ["#4FB6A6", "#6FA8DC", "#B18AE0", "#E8A24A", "#6FBF8E", "#E0955A", "#D98BB0"];

interface CallVM {
  key: string;
  name: string;
  argDig: string;
  argRaw: string;
  hasResult: boolean;
  resultDig: string;
  resultRaw: string;
  durStr: string;
  statusColor: string;
  statusWord: string;
}
type StepVM =
  | { kind: "prompt"; key: string; color: string; glow: string; timeStr: string; text: string }
  | {
      kind: "assistant";
      key: string;
      color: string;
      glow: string;
      timeStr: string;
      dt: string;
      hasThink: boolean;
      thinkText: string;
      thinkKey: string;
      hasCalls: boolean;
      callHeader: string;
      calls: CallVM[];
      hasText: boolean;
      text: string;
      uTok: string;
      uCost: string;
      turnPct: number;
    };

const secLabel = (color: string) => ({
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase" as const,
  color,
});

export function DetailView({ id, onBack }: Props) {
  const { sessions } = useRecorder();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showRecall, setShowRecall] = useState(false);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const d = useMemo(() => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return null;
    const t = s.totals;
    const ch = channelOf(s);
    const col = channelColor(ch);
    const isChat = ch === "chat";
    const oi = outcomeInfo(s);
    const eff = effortInfo(s);
    const tokTot = t.tokIn + t.tokOut + t.tokCache || 1;

    const vitals = [
      { label: "Duration", value: fmtDur(s.durMs), sub: t.asst + " agent turns", color: TEXT },
      { label: "Steps", value: "" + t.steps, sub: "events logged", color: TEXT },
      { label: "Tool calls", value: "" + t.tcalls, sub: Object.keys(s.toolCounts).length + " distinct", color: TEAL },
      { label: "Reasoning", value: "" + t.think, sub: "thinking blocks", color: VIOLET },
      { label: "Cost", value: fmtCost(t.cost), sub: "this session", color: AMBER },
      { label: "Tokens", value: fmtTok(t.tokIn + t.tokOut), sub: fmtTok(t.tokCache) + " cached", color: BLUE },
    ];

    // per-tool average latency
    const callTs: Record<string, { ts: string; name: string }> = {};
    (s.steps || []).forEach((x) => {
      if (x.k === "assistant") (x.calls || []).forEach((c) => (callTs[c.id] = { ts: x.ts, name: c.name }));
    });
    const toolAgg: Record<string, { sum: number; n: number }> = {};
    (s.steps || []).forEach((x) => {
      if (x.k === "result" && x.tcid && callTs[x.tcid]) {
        const nm = callTs[x.tcid].name;
        const dm = +new Date(x.ts) - +new Date(callTs[x.tcid].ts);
        if (!toolAgg[nm]) toolAgg[nm] = { sum: 0, n: 0 };
        if (dm >= 0) {
          toolAgg[nm].sum += dm;
          toolAgg[nm].n++;
        }
      }
    });
    const toolEntries = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
    const maxTool = toolEntries.length ? toolEntries[0][1] : 1;
    const toolBars = toolEntries.map((e, i) => {
      const ag = toolAgg[e[0]];
      const avg = ag && ag.n ? fmtDur(Math.round(ag.sum / ag.n)) : "";
      return {
        name: e[0],
        n: e[1],
        w: Math.max(6, (e[1] / maxTool) * 100),
        c1: hexA(TOOL_PALETTE[i % TOOL_PALETTE.length], 0.55),
        c2: TOOL_PALETTE[i % TOOL_PALETTE.length],
        avg,
      };
    });

    // pair results to calls
    const resultMap: Record<string, Extract<SessionStep, { k: "result" }>> = {};
    (s.steps || []).forEach((x) => {
      if (x.k === "result" && x.tcid) resultMap[x.tcid] = x;
    });

    // build the timeline
    let prevTs: string | null = null;
    let firstPromptSkipped = false;
    const steps: StepVM[] = [];
    (s.steps || []).forEach((x, i) => {
      if (x.k === "result") return;
      if (x.k === "prompt" && !firstPromptSkipped) {
        firstPromptSkipped = true;
        prevTs = x.ts;
        return;
      }
      const color = x.k === "prompt" ? BLUE : x.k === "assistant" ? AMBER : MUTED;
      const dtMs = prevTs != null ? +new Date(x.ts) - +new Date(prevTs) : 0;
      const dt = prevTs != null && dtMs > 0 ? "+" + fmtDur(dtMs) : "";
      prevTs = x.ts;

      if (x.k === "prompt") {
        let pt = x.text || "";
        const mi = pt.indexOf("[Recalled long-term memory");
        if (mi >= 0) pt = pt.slice(0, mi).trim();
        steps.push({
          kind: "prompt",
          key: "s" + i,
          color,
          glow: hexA(color, 0.5),
          timeStr: timeStr(x.ts),
          text: pt + (x.tr ? "\n…" : ""),
        });
      } else if (x.k === "assistant") {
        const thinkText = (x.think || []).map((tk) => tk.t + (tk.tr ? "…" : "")).join("\n\n");
        const calls = (x.calls || []).map((c, ci) => {
          const r = resultMap[c.id];
          let durStr = "";
          if (r) {
            const dm = +new Date(r.ts) - +new Date(x.ts);
            if (dm >= 0) durStr = fmtDur(dm);
          }
          return {
            key: "x" + i + "_" + ci,
            name: c.name,
            argDig: c.dig,
            argRaw: c.raw + (c.tr ? "\n…" : ""),
            hasResult: !!r,
            resultDig: r ? r.dig : "",
            resultRaw: r ? r.text + (r.tr ? "\n…[truncated]" : "") : "",
            durStr,
            statusColor: r ? (r.ok ? OK : ERROR) : DIMMER,
            statusWord: r ? (r.ok ? "· ok" : "· error") : "",
          } as CallVM;
        });
        const hasText = !!(x.text && x.text.trim());
        const cst = x.u ? x.u.cost : 0;
        const vm: StepVM = {
          kind: "assistant",
          key: "s" + i,
          color,
          glow: hexA(color, 0.5),
          timeStr: timeStr(x.ts),
          dt,
          hasThink: !!thinkText,
          thinkText,
          thinkKey: "t" + i,
          hasCalls: calls.length > 0,
          callHeader: calls.length > 1 ? "Called " + calls.length + " tools in parallel" : calls.length === 1 ? "Called 1 tool" : "",
          calls,
          hasText,
          text: (x.text || "") + (x.ttr ? "\n…" : ""),
          uTok: fmtTok(x.u ? x.u.i : 0) + " in · " + fmtTok(x.u ? x.u.o : 0) + " out",
          uCost: fmtCost(cst),
          turnPct: Math.round((cst / (t.cost || 1)) * 100),
        };
        steps.push(vm);
      }
    });
    // The final answer is shown once, in "Delivered output" — hide it from the
    // timeline by clearing the last assistant turn that carries text.
    for (let j = steps.length - 1; j >= 0; j--) {
      const sv = steps[j];
      if (sv.kind === "assistant" && sv.hasText) {
        sv.hasText = false;
        break;
      }
    }

    return {
      s,
      isChat,
      col,
      channel: channelLabel(ch),
      outcome: oi,
      eff,
      vitals,
      toolBars,
      toolEntries,
      steps,
      tokTot,
      tbInput: Math.round((t.tokIn / tokTot) * 100),
      tbOutput: Math.round((t.tokOut / tokTot) * 100),
      tbCache: Math.round((t.tokCache / tokTot) * 100),
    };
    // note: `open`/`showRecall` are read at render time, not memo deps.
  }, [sessions, id]);

  if (!d) {
    return (
      <div style={{ maxWidth: 920, margin: "0 auto", padding: 60, textAlign: "center", color: DIM, fontFamily: FONT_MONO }}>
        <button className="back-btn" onClick={onBack} style={backBtnStyle}>
          &larr; all sessions
        </button>
        <div style={{ marginTop: 30 }}>This run is no longer available.</div>
      </div>
    );
  }

  const { s, isChat, outcome, eff, vitals, toolBars, toolEntries, steps } = d;
  const t = s.totals;

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "0 0 calc(48px + env(safe-area-inset-bottom))" }}>
      {/* sticky header */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background: "rgba(10,11,14,.82)",
          borderBottom: "1px solid rgba(255,255,255,.08)",
        }}
      >
        <div
          style={{
            padding: "calc(14px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 14px max(16px, env(safe-area-inset-left))",
            display: "flex",
            alignItems: "center",
            gap: isMobile ? 8 : 14,
          }}
        >
          <button className="back-btn" onClick={onBack} style={backBtnStyle}>
            {isMobile ? <>&larr;</> : <>&larr; all sessions</>}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: TEXT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.title}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: DIM }}>
              {s.instance} · {dow(s.startTs)} {dateStr(s.startTs)} · {timeStr(s.startTs)}
            </div>
          </div>
          {(!isChat || outcome.running) && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: FONT_MONO,
                fontSize: 10,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                padding: isMobile ? "4px 8px" : "5px 11px",
                borderRadius: 6,
                background: hexA(outcome.color, 0.14),
                color: outcome.color,
                border: `1px solid ${hexA(outcome.color, 0.34)}`,
                whiteSpace: "nowrap",
              }}
            >
              {outcome.running && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: outcome.color,
                    boxShadow: `0 0 7px ${outcome.color}`,
                    animation: "rec-blink 1.4s ease-in-out infinite",
                  }}
                />
              )}
              {outcome.label}
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: "22px max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left))" }}>
        {/* engine strip */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 16 }}>
          {[
            { k: "Model", v: s.model || "—", strong: true, color: TEXT },
            { k: "SDK", v: "pi", strong: true, color: TEXT },
            { k: "Provider", v: s.provider || "—", strong: false, color: "#C9CBD1" },
          ].map((chip) => (
            <div
              key={chip.k}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(255,255,255,.03)",
                border: "1px solid rgba(255,255,255,.08)",
                borderRadius: 9,
                padding: "8px 12px",
                maxWidth: "100%",
                minWidth: 0,
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".14em", color: DIMMER, textTransform: "uppercase", flex: "none" }}>{chip.k}</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: chip.color,
                  fontWeight: chip.strong ? 600 : 400,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chip.v}
              </span>
            </div>
          ))}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: hexA(eff.color, 0.08),
              border: `1px solid ${hexA(eff.color, 0.24)}`,
              borderRadius: 9,
              padding: "8px 12px",
            }}
          >
            <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".14em", color: DIMMER, textTransform: "uppercase" }}>Effort</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: eff.color, fontWeight: 600 }}>{eff.label}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: DIM }}>{eff.detail}</span>
          </div>
        </div>

        {/* vitals */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(104px,1fr))", gap: 10 }}>
          {vitals.map((v) => (
            <div key={v.label} style={{ background: "rgba(255,255,255,.028)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "13px 14px" }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".14em", color: DIM, textTransform: "uppercase" }}>{v.label}</div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 21, fontWeight: 600, marginTop: 6, color: v.color }}>{v.value}</div>
              <div style={{ fontSize: 11, color: "#8b8d94", marginTop: 2 }}>{v.sub}</div>
            </div>
          ))}
        </div>

        {/* token composition */}
        <div style={{ marginTop: 12, background: "rgba(255,255,255,.028)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "15px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: DIM }}>
            <span>Token composition</span>
            <span>{fmtTok(d.tokTot)} total</span>
          </div>
          <div style={{ display: "flex", height: 9, borderRadius: 5, overflow: "hidden", background: "rgba(255,255,255,.05)" }}>
            <div style={{ background: BLUE, width: `${d.tbInput}%` }} />
            <div style={{ background: AMBER, width: `${d.tbOutput}%` }} />
            <div style={{ background: "#4a4d55", width: `${d.tbCache}%` }} />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 9, fontFamily: FONT_MONO, fontSize: 11, color: MUTED, flexWrap: "wrap" }}>
            <span>
              <span style={{ color: BLUE }}>■</span> {fmtTok(t.tokIn)} input
            </span>
            <span>
              <span style={{ color: AMBER }}>■</span> {fmtTok(t.tokOut)} output
            </span>
            <span>
              <span style={{ color: "#8b8d94" }}>■</span> {fmtTok(t.tokCache)} cache-read
            </span>
          </div>
        </div>

        {/* trigger */}
        <div style={{ marginTop: 22 }}>
          <div style={{ ...secLabel(BLUE), marginBottom: 9 }}>▼ Trigger</div>
          <div style={{ background: "rgba(111,168,220,.06)", border: "1px solid rgba(111,168,220,.2)", borderRadius: 13, padding: "16px 18px" }}>
            <Markdown src={s.instr + (s.instrTr ? "\n…" : "")} style={{ fontSize: 14, lineHeight: 1.55, color: "#D4D8DE", fontFamily: FONT_UI }} />
            {s.hasRecall && (
              <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 11 }}>
                <button
                  className="link-btn"
                  onClick={() => setShowRecall((v) => !v)}
                  style={{
                    cursor: "pointer",
                    background: "none",
                    border: "none",
                    color: "#8b8d94",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    letterSpacing: ".06em",
                    padding: "8px 4px",
                    margin: "0 0 0 -4px",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {showRecall ? "▾ hide recalled memory" : "▸ show recalled long-term memory"}
                </button>
                {showRecall && (
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: "#8b8d94",
                      marginTop: 10,
                      maxHeight: 260,
                      overflow: "auto",
                      padding: 12,
                      background: "rgba(0,0,0,.25)",
                      borderRadius: 9,
                    }}
                  >
                    {(s.recalled || "") + (s.recalledTr ? "\n…" : "")}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* tool usage */}
        {toolBars.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ ...secLabel(TEAL), marginBottom: 11 }}>
              ▼ Tool usage &nbsp;
              <span style={{ color: DIM }}>
                {t.tcalls} calls · {toolEntries.length} tools
              </span>
            </div>
            <div style={{ background: "rgba(255,255,255,.028)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14, padding: "15px 17px", display: "flex", flexDirection: "column", gap: 12 }}>
              {toolBars.map((tb) => (
                <div key={tb.name} style={{ display: "flex", alignItems: "center", gap: 13 }}>
                  <div style={{ width: "clamp(84px, 34vw, 144px)", flex: "none", display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: tb.c2, boxShadow: `0 0 8px ${tb.c1}`, flex: "none" }} />
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: "#DEDCD5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {tb.name}
                    </span>
                  </div>
                  <div style={{ flex: 1, height: 23, background: "rgba(255,255,255,.035)", borderRadius: 7, overflow: "hidden", position: "relative" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${tb.w}%`,
                        background: `linear-gradient(90deg,${tb.c1},${tb.c2})`,
                        borderRadius: 7,
                        transition: "width .6s",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,.16)",
                      }}
                    />
                    <span style={{ position: "absolute", right: 10, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT_MONO, fontSize: 10, color: "#8b8d94" }}>
                      {tb.avg}
                    </span>
                  </div>
                  <div style={{ width: 26, textAlign: "right", fontFamily: FONT_MONO, fontSize: 15, color: TEXT, fontWeight: 600 }}>{tb.n}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* session timeline */}
        <div style={{ marginTop: 30 }}>
          <div style={{ ...secLabel(MUTED), marginBottom: 16 }}>
            ▼ Session timeline &nbsp;
            <span style={{ color: DIM }}>
              {t.asst} agent turns · {t.steps} events
            </span>
          </div>
          <div style={{ position: "relative", paddingLeft: 26, borderLeft: "1px solid rgba(255,255,255,.09)" }}>
            {steps.map((st) => (
              <div key={st.key} style={{ position: "relative", marginBottom: 14 }}>
                <span
                  style={{
                    position: "absolute",
                    left: -32,
                    top: 3,
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: st.color,
                    boxShadow: `0 0 0 4px #0a0b0e,0 0 10px ${st.glow}`,
                  }}
                />
                {st.kind === "prompt" ? (
                  <div style={{ background: "rgba(111,168,220,.07)", border: "1px solid rgba(111,168,220,.2)", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: BLUE, fontWeight: 600 }}>User</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DIMMER }}>{st.timeStr}</span>
                    </div>
                    <Markdown src={st.text} style={{ fontSize: 14, lineHeight: 1.55, color: "#D4D8DE", fontFamily: FONT_UI }} />
                  </div>
                ) : (
                  <div style={{ background: "linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.012))", border: "1px solid rgba(255,255,255,.09)", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: AMBER, fontWeight: 600 }}>Agent</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DIMMER }}>
                        {st.dt} · {st.timeStr}
                      </span>
                    </div>

                    {st.hasThink && (
                      <div style={{ marginTop: 10 }}>
                        <button
                          className="think-btn"
                          onClick={() => toggle(st.thinkKey)}
                          style={{
                            cursor: "pointer",
                            background: "none",
                            border: "none",
                            padding: "8px 4px",
                            margin: "0 0 0 -4px",
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            color: VIOLET,
                            fontFamily: FONT_MONO,
                            fontSize: 11,
                            letterSpacing: ".04em",
                          }}
                        >
                          <span style={{ fontSize: 13 }}>{open[st.thinkKey] ? "▾" : "▸"}</span> reasoning
                        </button>
                        {open[st.thinkKey] && (
                          <div style={{ marginTop: 8, padding: "12px 14px", background: "rgba(177,138,224,.06)", borderLeft: "2px solid rgba(177,138,224,.4)", borderRadius: "0 9px 9px 0" }}>
                            <Markdown src={st.thinkText} style={{ fontFamily: FONT_SERIF, fontStyle: "italic", fontSize: 15, lineHeight: 1.62, color: "#CFC7DE" }} />
                          </div>
                        )}
                      </div>
                    )}

                    {st.hasCalls && (
                      <div style={{ marginTop: 11 }}>
                        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: TEAL, letterSpacing: ".06em", marginBottom: 7 }}>{st.callHeader}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {st.calls.map((c) => {
                            const isOpen = !!open[c.key];
                            return (
                              <div key={c.key} style={{ background: "rgba(79,182,166,.05)", border: "1px solid rgba(79,182,166,.16)", borderRadius: 9, overflow: "hidden" }}>
                                <div className="call-head" onClick={() => toggle(c.key)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 9, padding: "12px 11px", minHeight: 44 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.statusColor, flex: "none", boxShadow: `0 0 6px ${c.statusColor}` }} />
                                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600, color: "#6FD0C0" }}>{c.name}</span>
                                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: "#8b8d94", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {c.argDig}
                                  </span>
                                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: "#7d8088", whiteSpace: "nowrap" }}>{c.durStr}</span>
                                  <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: DIMMER }}>{isOpen ? "▾" : "▸"}</span>
                                </div>
                                {c.hasResult && !isOpen && (
                                  <div style={{ padding: "0 11px 9px 27px", fontSize: 12, color: "#8b8d94", lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {c.resultDig}
                                  </div>
                                )}
                                {isOpen && (
                                  <div style={{ padding: "2px 11px 11px" }}>
                                    <div style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: TEAL, margin: "4px 0 5px" }}>Input</div>
                                    <pre style={preStyle}>{c.argRaw}</pre>
                                    {c.hasResult && (
                                      <>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "11px 0 5px" }}>
                                          <span style={{ fontFamily: FONT_MONO, fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: c.statusColor }}>Output {c.statusWord}</span>
                                          <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DIMMER }}>{c.durStr}</span>
                                        </div>
                                        <pre style={{ ...preStyle, maxHeight: 280 }}>{c.resultRaw}</pre>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {st.hasText && (
                      <div style={{ marginTop: 11, borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 11 }}>
                        <Markdown src={st.text} style={{ fontSize: 14, lineHeight: 1.55, color: "#DEDCD5", fontFamily: FONT_UI }} />
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: DIM }}>{st.uTok}</span>
                      <div style={{ flex: 1 }} />
                      <div style={{ width: 70, height: 4, background: "rgba(255,255,255,.06)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${st.turnPct}%`, background: AMBER, borderRadius: 3 }} />
                      </div>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: AMBER, whiteSpace: "nowrap" }}>
                        {st.uCost} · {st.turnPct}% of run
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* delivered output */}
        <div style={{ marginTop: 26 }}>
          <div style={{ ...secLabel(AMBER), marginBottom: 11 }}>▼ Delivered output</div>
          {outcome.silent ? (
            <div style={{ background: "rgba(255,255,255,.02)", border: "1px dashed rgba(255,255,255,.14)", borderRadius: 13, padding: 20, textAlign: "center" }}>
              <div style={{ fontFamily: FONT_MONO, fontSize: 14, color: "#8b8d94", letterSpacing: ".05em" }}>NOTHING_TO_REPORT</div>
              <div style={{ fontSize: 13, color: DIM, marginTop: 6 }}>Scan completed — nothing worth interrupting you. Stayed silent.</div>
            </div>
          ) : (
            <div
              style={{
                background: "linear-gradient(180deg,rgba(232,162,74,.1),rgba(232,162,74,.03))",
                border: "1px solid rgba(232,162,74,.28)",
                borderRadius: 15,
                padding: "18px 20px",
                boxShadow: "0 12px 40px -18px rgba(232,162,74,.5)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: AMBER, display: "flex", alignItems: "center", justifyContent: "center", color: "#0a0b0e", fontWeight: 700, fontFamily: FONT_MONO, fontSize: 13 }}>
                  A
                </span>
                <div style={{ lineHeight: 1.1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{s.instance}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: "#9A7B4A" }}>
                    {outcome.running ? "Running · streaming live" : `${channelLabel(channelOf(s))} · delivered`}
                  </div>
                </div>
              </div>
              {s.finalText.trim() ? (
                <Markdown src={s.finalText + (s.finalTr ? "\n…" : "")} style={{ fontSize: 14, lineHeight: 1.6, color: "#ECE6DC", fontFamily: FONT_UI }} />
              ) : (
                <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: DIM }}>Still running — no final output yet.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const backBtnStyle: React.CSSProperties = {
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "rgba(255,255,255,.05)",
  border: "1px solid rgba(255,255,255,.1)",
  color: "#C9CBD1",
  fontFamily: FONT_MONO,
  fontSize: 12,
  minHeight: 44,
  padding: "10px 13px",
  borderRadius: 9,
  transition: "all .15s",
};

const preStyle: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: FONT_MONO,
  fontSize: 11,
  lineHeight: 1.5,
  color: MUTED,
  maxHeight: 200,
  overflow: "auto",
  background: "rgba(0,0,0,.3)",
  padding: 10,
  borderRadius: 7,
};
