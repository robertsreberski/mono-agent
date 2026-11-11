import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";

export type PdfExportState = { kind: "idle" } | { kind: "pending" }
  | { kind: "error"; message: string } | { kind: "ready"; url: string; filename: string };

export function usePdfExport(threadId: string | null) {
  const [state, setState] = useState<PdfExportState>({ kind: "idle" });
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const clear = (): void => {
    request.current?.abort(); request.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => { setState({ kind: "idle" }); return clear; }, [threadId]);
  const start = async (): Promise<void> => {
    if (threadId === null || request.current) return;
    clear();
    const controller = new AbortController(); request.current = controller;
    setState({ kind: "pending" });
    try {
      const { blob, filename } = await api.exportPdf(threadId, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob); objectUrl.current = url;
      setState({ kind: "ready", url, filename });
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.rel = "noopener noreferrer"; link.hidden = true;
      document.body.append(link);
      try { link.click(); } catch { /* The visible link supplies a fresh gesture if automatic download is blocked. */ } finally { link.remove(); }
      // Keep the URL alive for the visible, fresh-user-gesture fallback on iOS.
    } catch (error) {
      if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "PDF export failed. Try again." });
    } finally { if (request.current === controller) request.current = null; }
  };
  return { state, start, dismiss: () => { clear(); setState({ kind: "idle" }); } };
}

export function PdfExportNotice({ state, onDismiss }: { readonly state: PdfExportState; readonly onDismiss: () => void }) {
  if (state.kind === "idle") return null;
  return <div className="pdf-export-notice" role={state.kind === "error" ? "alert" : "status"} aria-live={state.kind === "error" ? "assertive" : "polite"} aria-busy={state.kind === "pending"}>
    <div>{state.kind === "pending" ? "Exporting PDF…" : state.kind === "error" ? state.message
      : <>PDF ready. <a href={state.url} download={state.filename} rel="noopener noreferrer">Download PDF</a></>}</div>
    <button type="button" className="icon-button" aria-label="Dismiss PDF export" onClick={onDismiss}><Icon name="close" size={16} /></button>
  </div>;
}
