import { useEffect, useState } from "react";
import { api } from "../../api";
import type { RestartOperation } from "../../types";

export function useLatestRestart(sourceId: string) {
  const [initialOperation, setInitialOperation] = useState<RestartOperation | null>(null);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const controller = new AbortController();
    setReadState("loading");
    void api.latestAgentRestart(sourceId, controller.signal).then((operation) => {
      if (controller.signal.aborted) return;
      setInitialOperation(operation);
      setReadState("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setReadState("error");
    });
    return () => controller.abort();
  }, [sourceId]);
  return { initialOperation, readState };
}
