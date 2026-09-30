import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { AuthGate, useAuth } from "./auth";
import { RenderErrorBoundary, RootErrorFallback } from "./components/RenderErrorBoundary";
import { ConsoleStoreProvider } from "./console-store";
import { observeTransferredResources } from "./data-usage";
import { NotificationsProvider } from "./notifications";
import { WebRuntimeProvider } from "./runtime";
import { registerServiceWorkerUpdates } from "./service-worker-update";
import "./styles.css";

// `prompt` mode: a new build is downloaded and staged, and `App` decides when
// it takes over -- never in the middle of a turn the operator is watching.
registerServiceWorkerUpdates(registerSW);

// Everything the browser fetches on the page's own behalf -- images above all --
// counted against the session meter the sidebar shows. Installed here rather
// than on import so nothing but the real app ever gets an observer.
observeTransferredResources();

function ConsoleProviders() {
  const { multiUser } = useAuth();
  const runtime = <WebRuntimeProvider><App /></WebRuntimeProvider>;
  return <ConsoleStoreProvider>{multiUser ? runtime : <NotificationsProvider>{runtime}</NotificationsProvider>}</ConsoleStoreProvider>;
}

createRoot(document.getElementById("root")!).render(
  <RenderErrorBoundary
    scope="console"
    fallback={() => <RootErrorFallback />}
  >
    <StrictMode>
      <AuthGate><ConsoleProviders /></AuthGate>
    </StrictMode>
  </RenderErrorBoundary>,
);
