// Formatting + derivation helpers — ported verbatim from the Session Recorder
// mock (Session Recorder.dc.html lines ~478-666), typed for TS.

import type { Session, SessionStep } from "./types";
import { CHANNEL_COLOR, CHANNEL_LABEL, MUTED, AMBER, OK, ERROR, BLUE, VIOLET } from "./tokens";

// The recorded agents run in Europe/Rome; keep the mock's fixed timezone so
// day-boundaries and tick labels are stable regardless of the viewer's locale.
const TZ = "Europe/Rome";

export function tz(ts: string | number, opt: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opt }).format(new Date(ts));
  } catch {
    return "";
  }
}
export const timeStr = (ts: string | number) =>
  tz(ts, { hour: "2-digit", minute: "2-digit", hour12: false });
export const dateStr = (ts: string | number) => tz(ts, { day: "2-digit", month: "short" });
export const dow = (ts: string | number) => tz(ts, { weekday: "short" });

export function fmtDur(ms: number): string {
  if (!ms || ms < 0) return "0s";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + "s";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m + "m" + (r ? " " + r + "s" : "");
}

export function fmtTok(n: number): string {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k";
  return "" + n;
}

export function fmtCost(n: number): string {
  n = n || 0;
  return n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2);
}

export function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function stepColor(s: SessionStep): string {
  if (s.k === "prompt") return BLUE;
  if (s.k === "assistant") return AMBER;
  if (s.k === "boundary") return VIOLET;
  if (s.k === "result") return s.ok ? OK : ERROR;
  return MUTED;
}

// Channel = how the run was triggered. Uses the real `session.source`.
export const channelOf = (s: Session): string => s.source;
export const channelColor = (c: string): string => CHANNEL_COLOR[c] || MUTED;
export const channelLabel = (c: string): string => CHANNEL_LABEL[c] || c;

// Kind palette (secondary; kept for completeness / parity with the mock).
export function kindColor(k?: string): string {
  return (
    ({ "focus-scan": "#4FB6A6", briefing: "#E8955A", proactive: "#B18AE0", chat: "#6FA8DC" } as Record<
      string,
      string
    >)[k || ""] || MUTED
  );
}
export function kindLabel(k?: string): string {
  return (
    ({ "focus-scan": "Focus scan", briefing: "Briefing", proactive: "Proactive", chat: "Chat" } as Record<
      string,
      string
    >)[k || ""] || (k ?? "")
  );
}

// Outcome badge state (also surfaces live "running" runs from the stream).
export interface OutcomeInfo {
  label: string;
  color: string;
  running: boolean;
  silent: boolean;
}
export function outcomeInfo(s: Session): OutcomeInfo {
  if (s.status === "running")
    return { label: "LIVE", color: "#4FB6A6", running: true, silent: false };
  if (s.status === "failed")
    return { label: "FAILED", color: ERROR, running: false, silent: false };
  if (s.status === "cancelled")
    return { label: "CANCELLED", color: "#E8955A", running: false, silent: false };
  if (s.status === "interrupted")
    return { label: "INTERRUPTED", color: "#E8955A", running: false, silent: false };
  const silent = s.outcome === "silent";
  return {
    label: silent ? "SILENT" : "NOTIFIED",
    color: silent ? "#8b8d94" : AMBER,
    running: false,
    silent,
  };
}

// Reasoning-effort chip derivation (from thinking density), ported from the
// mock's detailVals. Prefers an explicit `session.effort` when present.
export function effortInfo(s: Session): { label: string; color: string; detail: string } {
  const t = s.totals;
  const ratio = t.asst ? t.think / t.asst : 0;
  const derived = ratio >= 0.6 ? "High" : ratio >= 0.3 ? "Medium" : "Low";
  const color = ratio >= 0.6 ? VIOLET : ratio >= 0.3 ? BLUE : "#8b8d94";
  const label = s.effort ? s.effort.charAt(0).toUpperCase() + s.effort.slice(1) : derived;
  return { label, color, detail: "· " + ratio.toFixed(1) + " reasoning/turn" };
}

export interface Seg {
  color: string;
  flex: number;
}
// A compact per-step colour strip for a session card (capped at 42 segments).
export function segsFor(s: Session): Seg[] {
  const steps = s.steps || [];
  const cap = 42;
  let arr: Seg[] = steps.map((x) => ({ color: stepColor(x), flex: 1 }));
  if (arr.length > cap) {
    const out: Seg[] = [];
    const ratio = arr.length / cap;
    for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * ratio)]);
    arr = out;
  }
  if (arr.length === 0) arr = [{ color: "#3a3d45", flex: 1 }];
  return arr;
}
