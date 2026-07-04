import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "./lib/store";
import { useIsMobile } from "./lib/useIsMobile";
import { PAGE_BG, TEXT, FONT_UI, FONT_MONO, DIM } from "./lib/tokens";
import { ListView } from "./views/ListView";
import { InstancesView } from "./views/InstancesView";
import { DetailView } from "./views/DetailView";

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
  const { sessions, instances, status } = useRecorder();
  const isMobile = useIsMobile();
  const [view, setView] = useState<View>("list");
  const [selId, setSelId] = useState<string | null>(null);
  const [fChannel, setFChannel] = useState("all");
  const [fOut, setFOut] = useState("all");
  const [fInstance, setFInstance] = useState("all");
  const { ensureDetail } = useRecorder();
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
    setFChannel("all");
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
    ) : null;

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
        {view === "instances" ? (
          <InstancesView instances={instances} sessions={sessions} onOpenInstance={openInstance} />
        ) : (
          <ListView
            sessions={sessions}
            instances={instances}
            fChannel={fChannel}
            fOut={fOut}
            fInstance={fInstance}
            setFChannel={setFChannel}
            setFOut={setFOut}
            setFInstance={setFInstance}
            onOpen={open}
          />
        )}
      </div>
    </div>
  );
}
