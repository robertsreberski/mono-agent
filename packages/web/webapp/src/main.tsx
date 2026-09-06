import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConsoleStoreProvider>
      <NotificationsProvider>
        <WebRuntimeProvider>
          <App />
        </WebRuntimeProvider>
      </NotificationsProvider>
    </ConsoleStoreProvider>
  </StrictMode>,
);
