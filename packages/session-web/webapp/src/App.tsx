import { useCallback, useState } from "react";
import { useRecorder } from "./lib/store";
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
    padding: "8px 16px",
    borderRadius: 10,
    border: `1px solid ${active ? "rgba(255,255,255,.2)" : "rgba(255,255,255,.08)"}`,
    background: active ? "rgba(255,255,255,.1)" : "transparent",
    color: active ? TEXT : "#8b8d94",
    transition: "all .15s",
  });
  return (
    <div style={{ display: "flex", gap: 7, marginBottom: 26, alignItems: "center" }}>
      <button className="rec-chip" onClick={() => onNav("list")} style={btn(view !== "instances")}>
        Sessions
      </button>
      <button className="rec-chip" onClick={() => onNav("instances")} style={btn(view === "instances")}>
        Instances
      </button>
      <div style={{ marginLeft: "auto" }}>{statusPill}</div>
    </div>
  );
}

export function App() {
  const { sessions, instances, status } = useRecorder();
  const [view, setView] = useState<View>("list");
  const [selId, setSelId] = useState<string | null>(null);
  const [fChannel, setFChannel] = useState("all");
  const [fOut, setFOut] = useState("all");
  const [fInstance, setFInstance] = useState("all");
  const { ensureDetail } = useRecorder();

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
    setView("list");
    window.scrollTo?.(0, 0);
  }, []);

  const page: React.CSSProperties = {
    minHeight: "100vh",
    background: PAGE_BG,
    color: TEXT,
    fontFamily: FONT_UI,
    WebkitFontSmoothing: "antialiased",
  };

  if (view === "detail" && selId) {
    return (
      <div style={page}>
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
        }}
      >
        demo data
      </span>
    ) : null;

  return (
    <div style={page}>
      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "34px 22px 90px" }}>
        <TopNav view={view} onNav={setView} statusPill={statusPill} />
        {view === "instances" ? (
          <InstancesView sessions={sessions} onOpenInstance={openInstance} />
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
