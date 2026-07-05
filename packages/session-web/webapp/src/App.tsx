import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "./lib/store";
import { clearAuthToken, saveAuthToken } from "./lib/api";
import { useIsMobile } from "./lib/useIsMobile";
import { PAGE_BG, TEXT, FONT_UI, FONT_MONO, DIM } from "./lib/tokens";
import { ListView } from "./views/ListView";
import { InstancesView } from "./views/InstancesView";
import { DetailView } from "./views/DetailView";
import { makeDefaultExcludedChannels } from "./views/list-model";

type View = "list" | "instances" | "detail";

function TopNav({
  view,
  onNav,
  statusPill,
}: {
  view: View;
  onNav: (v: View) => void;
  statusPill: React.ReactNode;
}) {
  const btn = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    fontFamily: FONT_MONO,
    fontSize: 12,
    letterSpacing: ".04em",
    padding: "10px 16px",
    minHeight: 44,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 10,
    border: `1px solid ${active ? "rgba(255,255,255,.2)" : "rgba(255,255,255,.08)"}`,
    background: active ? "rgba(255,255,255,.1)" : "transparent",
    color: active ? TEXT : "#8b8d94",
    transition: "all .15s",
  });
  return (
    <div style={{ display: "flex", gap: 7, marginBottom: 26, alignItems: "center", flexWrap: "wrap", rowGap: 8 }}>
      <button
        className="rec-chip"
        onClick={() => onNav("list")}
        style={btn(view !== "instances")}
        aria-current={view !== "instances" ? "page" : undefined}
      >
        Sessions
      </button>
      <button
        className="rec-chip"
        onClick={() => onNav("instances")}
        style={btn(view === "instances")}
        aria-current={view === "instances" ? "page" : undefined}
      >
        Instances
      </button>
      <div style={{ marginLeft: "auto" }}>{statusPill}</div>
    </div>
  );
}

export function App() {
  const { sessions, instances, status, error, ensureDetail, reload } = useRecorder();
  const isMobile = useIsMobile();
  const [view, setView] = useState<View>("list");
  const [selId, setSelId] = useState<string | null>(null);
  const [excludedChannels, setExcludedChannels] = useState<ReadonlySet<string>>(() => makeDefaultExcludedChannels());
  const [fOut, setFOut] = useState("all");
  const [fInstance, setFInstance] = useState("all");
  const [tokenInput, setTokenInput] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);

  const open = useCallback(
    (id: string) => {
      ensureDetail(id);
      setSelId(id);
      setView("detail");
      window.scrollTo?.(0, 0);
    },
    [ensureDetail],
  );

  const openInstance = useCallback((name: string) => {
    setFInstance(name);
    setExcludedChannels(makeDefaultExcludedChannels());
    setFOut("all");
    setView("list");
    window.scrollTo?.(0, 0);
  }, []);

  // On view switch, move focus to the page container so keyboard/AT users
  // aren't stranded on document.body. Programmatic + non-visual (no ring).
  useEffect(() => {
    pageRef.current?.focus({ preventScroll: true });
  }, [view]);

  const page: React.CSSProperties = {
    minHeight: "100dvh",
    background: PAGE_BG,
    color: TEXT,
    fontFamily: FONT_UI,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
  };

  if (view === "detail" && selId) {
    return (
      <div ref={pageRef} tabIndex={-1} style={page}>
        <DetailView
          key={selId}
          id={selId}
          onBack={() => setView("list")}
        />
      </div>
    );
  }

  const statusPill =
    status === "fixture" ? (
      <span
        title="No backend reachable — showing bundled demo data"
        aria-label="No backend reachable — showing bundled demo data"
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: DIM,
          border: "1px solid rgba(255,255,255,.1)",
          borderRadius: 999,
          padding: "5px 11px",
          background: "rgba(255,255,255,.03)",
          whiteSpace: "nowrap",
          flex: "none",
        }}
      >
        demo data
      </span>
    ) : status === "reconnecting" ? (
      <span
        title="Loaded latest snapshot — reconnecting to live updates"
        aria-label="Loaded latest snapshot — reconnecting to live updates"
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "#E8A24A",
          border: "1px solid rgba(232,162,74,.32)",
          borderRadius: 999,
          padding: "5px 11px",
          background: "rgba(232,162,74,.09)",
          whiteSpace: "nowrap",
          flex: "none",
        }}
      >
        reconnecting
      </span>
    ) : status === "error" ? (
      <span
        title={error || "Session web backend unavailable"}
        aria-label={error || "Session web backend unavailable"}
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "#E0685B",
          border: "1px solid rgba(224,104,91,.35)",
          borderRadius: 999,
          padding: "5px 11px",
          background: "rgba(224,104,91,.1)",
          whiteSpace: "nowrap",
          flex: "none",
        }}
      >
        backend error
      </span>
    ) : null;
  const isAuthError = status === "error" && /(?:^|[^0-9])40[13](?:[^0-9]|$)/.test(error || "");

  return (
    <div ref={pageRef} tabIndex={-1} style={page}>
      <div
        style={{
          maxWidth: 1160,
          margin: "0 auto",
          padding: `calc(${isMobile ? 18 : 24}px + env(safe-area-inset-top)) max(${
            isMobile ? 12 : 16
          }px, env(safe-area-inset-right)) calc(${isMobile ? 72 : 84}px + env(safe-area-inset-bottom)) max(${
            isMobile ? 12 : 16
          }px, env(safe-area-inset-left))`,
        }}
      >
        <TopNav view={view} onNav={setView} statusPill={statusPill} />
        {status === "error" ? (
          <div style={{ margin: "48px auto", maxWidth: 640, border: "1px solid rgba(224,104,91,.24)", borderRadius: 14, padding: 24, background: "rgba(224,104,91,.06)" }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: ".16em", color: "#E0685B", textTransform: "uppercase", marginBottom: 10 }}>{isAuthError ? "Authentication required" : "Backend error"}</div>
            <div style={{ color: TEXT, fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{isAuthError ? "Enter the session-web token." : "Session data could not be loaded."}</div>
            <div style={{ color: DIM, fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>{error || "The session-web API returned an error."}</div>
            {isAuthError && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  saveAuthToken(tokenInput);
                  reload();
                }}
                style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 16 }}
              >
                <input
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.currentTarget.value)}
                  placeholder="Bearer token"
                  aria-label="Session-web bearer token"
                  style={{
                    flex: "1 1 220px",
                    minWidth: 0,
                    minHeight: 44,
                    borderRadius: 9,
                    border: "1px solid rgba(255,255,255,.16)",
                    background: "rgba(0,0,0,.28)",
                    color: TEXT,
                    fontFamily: FONT_MONO,
                    fontSize: 13,
                    padding: "10px 12px",
                  }}
                />
                <button
                  className="rec-btn"
                  type="submit"
                  style={{
                    cursor: "pointer",
                    minHeight: 44,
                    borderRadius: 9,
                    border: "1px solid rgba(232,162,74,.36)",
                    background: "rgba(232,162,74,.12)",
                    color: "#F0BE73",
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    padding: "10px 14px",
                  }}
                >
                  Retry
                </button>
                <button
                  className="rec-btn"
                  type="button"
                  onClick={() => {
                    clearAuthToken();
                    setTokenInput("");
                    reload();
                  }}
                  style={{
                    cursor: "pointer",
                    minHeight: 44,
                    borderRadius: 9,
                    border: "1px solid rgba(255,255,255,.12)",
                    background: "rgba(255,255,255,.04)",
                    color: "#C9CBD1",
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    padding: "10px 14px",
                  }}
                >
                  Clear
                </button>
              </form>
            )}
          </div>
        ) : view === "instances" ? (
          <InstancesView instances={instances} sessions={sessions} onOpenInstance={openInstance} />
        ) : (
          <ListView
            sessions={sessions}
            instances={instances}
            excludedChannels={excludedChannels}
            fOut={fOut}
            fInstance={fInstance}
            setExcludedChannels={setExcludedChannels}
            setFOut={setFOut}
            setFInstance={setFInstance}
            onOpen={open}
          />
        )}
      </div>
    </div>
  );
}
