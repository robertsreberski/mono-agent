import { useMemo } from "react";

import { ConfigUiClient } from "./api.js";
import { ConfigForm } from "./components/ConfigForm.js";
import { readRuntime } from "./runtime.js";

export default function App() {
  const runtime = readRuntime();
  const client = useMemo(
    () => new ConfigUiClient(runtime.baseUrl, runtime.token),
    [runtime.baseUrl, runtime.token],
  );

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Mono Agent — Config</h1>
        <p className="app__subtitle">Local-only configuration for this agent's runtime.</p>
      </header>
      <ConfigForm client={client} />
    </main>
  );
}
