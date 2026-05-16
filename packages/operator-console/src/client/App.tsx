import { useEffect, useMemo, useState } from "react";

import { OperatorConsoleClient } from "./api.js";
import { ConfigForm } from "./components/ConfigForm.js";
import { TraceabilityView } from "./components/TraceabilityView.js";
import { Button } from "./components/ui/button.js";
import { Separator } from "./components/ui/separator.js";
import { readRuntime } from "./runtime.js";

type ViewName = "settings" | "traceability";

export default function App() {
  const runtime = readRuntime();
  const client = useMemo(
    () => new OperatorConsoleClient(runtime.baseUrl, runtime.token),
    [runtime.baseUrl, runtime.token],
  );
  const [view, setView] = useHashView();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 py-6 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:gap-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">Mono Agent Console</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Local settings for this agent's runtime, identity, memory,
            tools, adapters, and recorded request artifacts. Edits are persisted to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              mono-agent.config.json
            </code>{" "}
            via the local console.
          </p>
        </div>
        <nav className="flex min-w-0 gap-2 overflow-x-auto rounded-xl bg-muted/60 p-1" aria-label="Primary views">
          <NavButton active={view === "settings"} onClick={() => setView("settings")}>Settings</NavButton>
          <NavButton active={view === "traceability"} onClick={() => setView("traceability")}>Traceability</NavButton>
        </nav>
      </header>
      <Separator />
      <div className="min-w-0">
        {view === "settings" ? <ConfigForm client={client} /> : <TraceabilityView client={client} />}
      </div>
    </main>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="min-w-fit px-4"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function useHashView(): readonly [ViewName, (next: ViewName) => void] {
  const [view, setViewState] = useState<ViewName>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => {
      setViewState(viewFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setView = (next: ViewName): void => {
    setViewState(next);
    const nextHash = `#${next}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  };

  return [view, setView] as const;
}

function viewFromHash(hash: string): ViewName {
  return hash === "#traceability" || hash === "#observability" ? "traceability" : "settings";
}
