import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ConsoleStoreProvider } from "./console-store";
import { WebRuntimeProvider } from "./runtime";
import "./styles.css";

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConsoleStoreProvider>
      <WebRuntimeProvider>
        <App />
      </WebRuntimeProvider>
    </ConsoleStoreProvider>
  </StrictMode>,
);
