import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { AgentSummary, ProviderAuthCheckSessionSnapshot, ProviderAuthMethod, ProviderAuthProviderStatus, ProviderAuthSessionSnapshot, ProviderAuthStatusSnapshot } from "../../types";
import { useProviderUsage } from "../ProviderUsageMeters";
import { checkTerminal, providerAuthResourceAbsent, terminal } from "./provider-auth-presentation";

export function useProviderAuth(agent: AgentSummary) {
  const [status, setStatus] = useState<ProviderAuthStatusSnapshot | null>(null);
  const [session, setSession] = useState<ProviderAuthSessionSnapshot | null>(null);
  const [check, setCheck] = useState<ProviderAuthCheckSessionSnapshot | null>(null);
  const { snapshot: usage, loading: usageLoading, refreshing: usageRefreshing, feedback: usageFeedback, refresh: refreshUsage } = useProviderUsage(agent, session?.state === "succeeded" ? session.id : undefined);
  const [sessionProvider, setSessionProvider] = useState<ProviderAuthProviderStatus | null>(null);
  const [methodProvider, setMethodProvider] = useState<ProviderAuthProviderStatus | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const sessionRef = useRef<ProviderAuthSessionSnapshot | null>(null);
  const checkRef = useRef<ProviderAuthCheckSessionSnapshot | null>(null);
  const mountedRef = useRef(true);
  const lifecycleRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const latestSessionRequestRef = useRef(0);
  const latestSuccessfulStartRef = useRef(0);
  const pendingOperationsRef = useRef(new Set<number>());
  const replacementOperationsRef = useRef(new Set<number>());
  const statusRequestSequenceRef = useRef(0);
  const statusRefreshControllersRef = useRef(new Set<AbortController>());
  const sourceId = agent.sourceId;
  const scopeKey = `${sourceId}:${agent.generation ?? "unknown"}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  const beginOperation = (sessionRequest = false, replacement = false) => {
    const requestId = ++requestSequenceRef.current;
    pendingOperationsRef.current.add(requestId);
    if (sessionRequest) latestSessionRequestRef.current = requestId;
    if (replacement) replacementOperationsRef.current.add(requestId);
    setBusy(true);
    if (replacement) setRestarting(true);
    return requestId;
  };

  const finishOperation = (requestId: number, requestScope: string) => {
    pendingOperationsRef.current.delete(requestId);
    replacementOperationsRef.current.delete(requestId);
    if (!mountedRef.current || scopeRef.current !== requestScope) return;
    setBusy(pendingOperationsRef.current.size > 0);
    setRestarting(replacementOperationsRef.current.size > 0);
  };

  const adoptSession = (next: ProviderAuthSessionSnapshot | null) => {
    sessionRef.current = next;
    setSession(next);
  };

  const adoptCheck = (next: ProviderAuthCheckSessionSnapshot | null) => {
    checkRef.current = next;
    setCheck(next);
  };

  // Keep admission POSTs observable until they return their resource ID. If
  // this owner has gone away, cancel only that returned resource, best effort.
  const cancelUnownedAdmission = (kind: "auth" | "check", id: string) => {
    const cancel = kind === "auth" ? api.cancelProviderAuth : api.cancelProviderAuthCheck;
    void cancel(sourceId, id, AbortSignal.timeout(2_000)).catch(() => undefined);
  };

  const invalidateStatusRefreshes = () => {
    statusRequestSequenceRef.current += 1;
    for (const controller of statusRefreshControllersRef.current) controller.abort();
    statusRefreshControllersRef.current.clear();
  };

  const adoptAuthenticatedSession = (next: ProviderAuthSessionSnapshot) => {
    invalidateStatusRefreshes();
    const retainedCheck = checkRef.current;
    if (retainedCheck !== null && checkTerminal(retainedCheck.state)) adoptCheck(null);
    adoptSession(next);
  };

  const refresh = () => {
    const controller = new AbortController();
    const requestId = ++statusRequestSequenceRef.current;
    const requestScope = scopeKey;
    statusRefreshControllersRef.current.add(controller);
    void api.providerAuthStatus(sourceId, controller.signal).then((next) => {
      if (controller.signal.aborted
        || !mountedRef.current
        || scopeRef.current !== requestScope
        || requestId !== statusRequestSequenceRef.current) return;
      setStatus(next);
    }).catch((caught) => {
      if (controller.signal.aborted
        || !mountedRef.current
        || scopeRef.current !== requestScope
        || requestId !== statusRequestSequenceRef.current) return;
      setAuthError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      statusRefreshControllersRef.current.delete(controller);
    });
    return controller;
  };

  useEffect(() => {
    if (agent.supportsProviderAuth !== true || agent.status === "offline") return;
    // A completed usage read may have added passive credential evidence. This
    // re-reads only local auth status; it never starts another vendor request.
    const controller = refresh();
    return () => controller.abort();
  }, [sourceId, agent.generation, agent.status, agent.supportsProviderAuth, usage]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      requestSequenceRef.current += 1;
      const current = sessionRef.current;
      if (current !== null && !terminal(current.state)) {
        void api.cancelProviderAuth(sourceId, current.id, AbortSignal.timeout(2_000)).catch(() => undefined);
      }
      const currentCheck = checkRef.current;
      if (currentCheck !== null && !checkTerminal(currentCheck.state)) {
        void api.cancelProviderAuthCheck(sourceId, currentCheck.id, AbortSignal.timeout(2_000)).catch(() => undefined);
      }
      sessionRef.current = null;
      checkRef.current = null;
      pendingOperationsRef.current.clear();
      replacementOperationsRef.current.clear();
      invalidateStatusRefreshes();
    };
  }, [sourceId, agent.generation]);

  useEffect(() => {
    if (session === null || terminal(session.state)) {
      if (session?.state === "succeeded") {
        const controller = refresh();
        return () => controller.abort();
      }
      return;
    }
    const controller = new AbortController();
    const expectedSessionId = session.id;
    const expectedScope = scopeKey;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(() => {
        void api.providerAuthSession(sourceId, expectedSessionId, controller.signal).then((next) => {
          if (controller.signal.aborted || scopeRef.current !== expectedScope || sessionRef.current?.id !== expectedSessionId || terminal(sessionRef.current.state)) return;
          setAuthError(null);
          adoptSession(next);
          if (!terminal(next.state)) poll();
        }).catch((caught) => {
          if (controller.signal.aborted || scopeRef.current !== expectedScope || sessionRef.current?.id !== expectedSessionId || terminal(sessionRef.current.state)) return;
          if (providerAuthResourceAbsent(caught)) {
            adoptSession(null);
            setSessionProvider(null);
            setAuthError(null);
            return;
          }
          setAuthError(caught instanceof Error ? caught.message : String(caught));
          poll();
        });
      }, 1_000);
    };
    poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sourceId, scopeKey, session?.id, session?.state]);

  useEffect(() => {
    if (check === null || checkTerminal(check.state)) {
      if (check !== null) {
        const controller = refresh();
        return () => controller.abort();
      }
      return;
    }
    const controller = new AbortController();
    const expectedCheckId = check.id;
    const expectedScope = scopeKey;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(() => {
        void api.providerAuthCheck(sourceId, expectedCheckId, controller.signal).then((next) => {
          if (controller.signal.aborted || scopeRef.current !== expectedScope || checkRef.current?.id !== expectedCheckId || checkTerminal(checkRef.current.state)) return;
          setAuthError(null);
          adoptCheck(next);
          if (!checkTerminal(next.state)) poll();
        }).catch((caught) => {
          if (controller.signal.aborted || scopeRef.current !== expectedScope || checkRef.current?.id !== expectedCheckId || checkTerminal(checkRef.current.state)) return;
          if (providerAuthResourceAbsent(caught)) {
            adoptCheck(null);
            setAuthError(null);
            return;
          }
          setAuthError(caught instanceof Error ? caught.message : String(caught));
          poll();
        });
      }, 1_000);
    };
    poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sourceId, scopeKey, check?.id, check?.state]);
  const start = async (provider: ProviderAuthProviderStatus, method: ProviderAuthMethod) => {
    const replacing = sessionRef.current !== null && !terminal(sessionRef.current.state);
    const requestId = beginOperation(true, replacing);
    const requestScope = scopeKey;
    const lifecycle = lifecycleRef.current;
    setAuthError(null);
    setMethodProvider(null);
    try {
      const next = await api.beginProviderAuth(sourceId, provider.providerId, method);
      if (!mountedRef.current || lifecycleRef.current !== lifecycle || scopeRef.current !== requestScope) {
        if (!terminal(next.state)) cancelUnownedAdmission("auth", next.id);
        return;
      }
      if (scopeRef.current === requestScope && requestId > latestSuccessfulStartRef.current) {
        latestSuccessfulStartRef.current = requestId;
        adoptAuthenticatedSession(next);
        setSessionProvider(provider);
        setInputValue("");
        setAuthError(null);
      }
    } catch (caught) {
      if (mountedRef.current && lifecycleRef.current === lifecycle && scopeRef.current === requestScope
        && requestId === latestSessionRequestRef.current
        && requestId > latestSuccessfulStartRef.current) {
        setAuthError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      finishOperation(requestId, requestScope);
    }
  };

  const startCheck = async () => {
    const requestId = beginOperation();
    const requestScope = scopeKey;
    const lifecycle = lifecycleRef.current;
    setAuthError(null);
    setMethodProvider(null);
    try {
      const next = await api.beginProviderAuthCheck(sourceId, crypto.randomUUID());
      if (!mountedRef.current || lifecycleRef.current !== lifecycle || scopeRef.current !== requestScope) {
        if (!checkTerminal(next.state)) cancelUnownedAdmission("check", next.id);
        return;
      }
      adoptCheck(next);
    } catch (caught) {
      if (mountedRef.current && lifecycleRef.current === lifecycle && scopeRef.current === requestScope) setAuthError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      finishOperation(requestId, requestScope);
    }
  };

  const cancelCheck = async () => {
    if (check === null) return;
    const requestId = beginOperation();
    const requestScope = scopeKey;
    setAuthError(null);
    try {
      await api.cancelProviderAuthCheck(sourceId, check.id);
      if (scopeRef.current === requestScope && checkRef.current?.id === check.id) {
        adoptCheck({ ...check, state: "cancelled", updatedAt: new Date().toISOString() });
      }
    } catch (caught) {
      if (scopeRef.current === requestScope && checkRef.current?.id === check.id) {
        if (providerAuthResourceAbsent(caught)) {
          adoptCheck(null);
          setAuthError(null);
        } else {
          setAuthError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    } finally {
      finishOperation(requestId, requestScope);
    }
  };

  const openFlow = (provider: ProviderAuthProviderStatus) => {
    setMethodProvider(provider);
    setAuthError(null);
    const recommended = provider.methods.find((method) => method.recommended);
    if (provider.methods.length === 1 || provider.providerId === "openai-codex" && recommended !== undefined) {
      void start(provider, provider.methods.length === 1 ? provider.methods[0]! : recommended!);
    }
  };

  const submit = async () => {
    if (session?.prompt === undefined || inputValue.length === 0 && session.prompt.allowEmpty !== true) return;
    const expectedSessionId = session.id;
    const requestId = beginOperation(true);
    const requestScope = scopeKey;
    const value = inputValue;
    if (inputRef.current !== null) inputRef.current.value = "";
    setInputValue("");
    setAuthError(null);
    try {
      const next = await api.submitProviderAuth(sourceId, expectedSessionId, { promptId: session.prompt.id, value });
      if (scopeRef.current === requestScope
        && requestId === latestSessionRequestRef.current
        && sessionRef.current?.id === expectedSessionId) {
        adoptSession(next);
      }
    } catch (caught) {
      if (scopeRef.current === requestScope
        && requestId === latestSessionRequestRef.current
        && sessionRef.current?.id === expectedSessionId) {
        setAuthError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      finishOperation(requestId, requestScope);
    }
  };

  const cancel = async () => {
    if (session === null) return;
    const expectedSessionId = session.id;
    const requestId = beginOperation(true);
    const requestScope = scopeKey;
    try {
      await api.cancelProviderAuth(sourceId, expectedSessionId);
      if (scopeRef.current === requestScope
        && requestId === latestSessionRequestRef.current
        && sessionRef.current?.id === expectedSessionId) {
        adoptSession({ ...session, state: "cancelled", updatedAt: new Date().toISOString() });
      }
    } catch (caught) {
      if (scopeRef.current === requestScope
        && requestId === latestSessionRequestRef.current
        && sessionRef.current?.id === expectedSessionId) {
        setAuthError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      finishOperation(requestId, requestScope);
    }
  };

  const checkActive = check !== null && !checkTerminal(check.state);
  return { status, session, check, usage, usageLoading, usageRefreshing, usageFeedback, refreshUsage, sessionProvider, methodProvider, inputValue, setInputValue, busy, restarting, authError, inputRef, adoptSession, setSessionProvider, setMethodProvider, start, startCheck, cancelCheck, openFlow, submit, cancel, checkActive };
}
