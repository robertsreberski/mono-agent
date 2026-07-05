import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted fonts (bundled + precached by the SW so the PWA works offline).
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/500-italic.css";

import "./styles.css";
import { App } from "./App";
import { RecorderProvider } from "./lib/store";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RecorderProvider>
      <App />
    </RecorderProvider>
  </StrictMode>,
);
