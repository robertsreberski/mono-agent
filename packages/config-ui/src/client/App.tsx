import { useMemo } from "react";

import { ConfigUiClient } from "./api.js";
import { ConfigForm } from "./components/ConfigForm.js";
import { Separator } from "./components/ui/separator.js";
import { readRuntime } from "./runtime.js";

export default function App() {
  const runtime = readRuntime();
  const client = useMemo(
    () => new ConfigUiClient(runtime.baseUrl, runtime.token),
    [runtime.baseUrl, runtime.token],
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-medium tracking-tight">Mono Agent — Config</h1>
        <p className="text-sm text-muted-foreground">
          Local configuration for this agent's runtime, identity, memory,
          tools, and optional adapters. Edits are persisted to{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            mono-agent.config.json
          </code>{" "}
          via the loopback bridge.
        </p>
      </header>
      <Separator />
      <ConfigForm client={client} />
    </main>
  );
}
