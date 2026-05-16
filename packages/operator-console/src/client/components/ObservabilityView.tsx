import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RecordedRunDetail,
  RecordedRunEvent,
  RecordedRunEventCategory,
  RecordedRunListItem,
} from "@worklab-ai/observability";

import type {
  OperatorConsoleClient,
  ObservabilityRunsResponse,
} from "../api.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";

interface ObservabilityViewProps {
  readonly client: OperatorConsoleClient;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly response: ObservabilityRunsResponse }
  | { readonly kind: "error"; readonly message: string };

type DetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly runId: string }
  | { readonly kind: "ready"; readonly run: RecordedRunDetail; readonly warnings: readonly string[] }
  | { readonly kind: "error"; readonly runId: string; readonly message: string };

const CATEGORY_BADGES: Record<RecordedRunEventCategory, "default" | "secondary" | "outline" | "success" | "warning" | "destructive"> = {
  tool: "default",
  thinking: "warning",
  message: "secondary",
  runtime: "outline",
  error: "destructive",
};

export function ObservabilityView({ client }: ObservabilityViewProps): React.JSX.Element {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const selectedRunIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const loadDetail = useCallback(
    async (runId: string): Promise<void> => {
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      setDetailState({ kind: "loading", runId });
      try {
        const response = await client.fetchObservedRun(runId);
        if (!response.enabled) {
          setDetailState({ kind: "error", runId, message: "Observability is disabled for this console." });
          return;
        }
        if (response.run === undefined) {
          setDetailState({ kind: "error", runId, message: "Recorded run was not found." });
          return;
        }
        setDetailState({ kind: "ready", run: response.run, warnings: response.warnings ?? response.run.warnings });
      } catch (error) {
        setDetailState({ kind: "error", runId, message: errorMessage(error) });
      }
    },
    [client],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setListState({ kind: "loading" });
    try {
      const response = await client.fetchObservedRuns();
      setListState({ kind: "ready", response });
      if (response.enabled && response.runs.length > 0) {
        const currentRunId = selectedRunIdRef.current;
        const nextRunId = currentRunId !== undefined && response.runs.some((run) => run.runId === currentRunId)
          ? currentRunId
          : response.runs[0]?.runId;
        if (nextRunId !== undefined) {
          await loadDetail(nextRunId);
        }
      } else {
        selectedRunIdRef.current = undefined;
        setSelectedRunId(undefined);
        setDetailState({ kind: "idle" });
      }
    } catch (error) {
      setListState({ kind: "error", message: errorMessage(error) });
      setDetailState({ kind: "idle" });
    }
  }, [client, loadDetail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const listResponse = listState.kind === "ready" ? listState.response : undefined;

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)]" aria-labelledby="observability-title">
      <Card className="min-w-0">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle id="observability-title">Observability</CardTitle>
              <CardDescription>
                Recorded requests and visible runtime events from JSONL artifacts. Private model chain-of-thought is not inferred or exposed.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => void refresh()} disabled={listState.kind === "loading"}>
              {listState.kind === "loading" ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          {listResponse?.artifactDir !== undefined ? (
            <p className="truncate rounded-md bg-muted px-2 py-1 font-mono text-[0.7rem] text-muted-foreground" title={listResponse.artifactDir}>
              {listResponse.artifactDir}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <ListStatus state={listState} />
          {listResponse?.enabled
            ? listResponse.warnings?.map((warning) => (
              <WarningNotice key={warning} warning={warning} />
            ))
            : null}
          {listResponse !== undefined && listResponse.enabled && listResponse.runs.length > 0 ? (
            <RunList runs={listResponse.runs} selectedRunId={selectedRunId} onSelect={(runId) => void loadDetail(runId)} />
          ) : null}
        </CardContent>
      </Card>

      <RunDetailPanel state={detailState} selectedRunId={selectedRunId} />
    </section>
  );
}

function ListStatus({ state }: { readonly state: ListState }): React.JSX.Element | null {
  if (state.kind === "loading") {
    return <StatusBox label="Loading recorded runs…" />;
  }
  if (state.kind === "error") {
    return <StatusBox tone="error" label={state.message} />;
  }
  if (!state.response.enabled) {
    return <StatusBox label={state.response.warnings?.[0] ?? "Observability is disabled."} />;
  }
  if (state.response.runs.length === 0) {
    return <StatusBox label="No recorded runs yet. Send a demo request, then refresh this view." />;
  }
  return null;
}

function RunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  readonly runs: readonly RecordedRunListItem[];
  readonly selectedRunId: string | undefined;
  readonly onSelect: (runId: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2" aria-label="Recorded runs">
      {runs.map((run) => {
        const selected = run.runId === selectedRunId;
        return (
          <button
            key={run.runId}
            type="button"
            onClick={() => onSelect(run.runId)}
            className={`min-w-0 rounded-lg border p-3 text-left transition hover:bg-muted/60 ${selected ? "border-primary bg-primary/5" : "border-border bg-background"}`}
            aria-pressed={selected}
          >
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between lg:flex-col lg:items-stretch xl:flex-row xl:items-start">
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={statusBadge(run.status)}>{run.status}</Badge>
                  {run.failureKind !== undefined ? <Badge variant="destructive">{run.failureKind}</Badge> : null}
                </div>
                <p className="truncate font-mono text-xs text-foreground" title={run.runId}>{run.runId}</p>
                <p className="truncate text-xs text-muted-foreground" title={run.conversationId}>{run.conversationId}</p>
              </div>
              <div className="flex flex-wrap gap-1 text-[0.7rem] text-muted-foreground">
                <span>{formatDuration(run.durationMs)}</span>
                <span>• {run.eventCount} events</span>
                {run.usage !== undefined || run.cost !== undefined ? <span>• usage/cost</span> : null}
                {run.capabilitiesUsed !== undefined ? <span>• capabilities</span> : null}
              </div>
            </div>
            <p className="mt-2 text-[0.7rem] text-muted-foreground">Updated {formatDate(run.updatedAt)}</p>
          </button>
        );
      })}
    </div>
  );
}

function RunDetailPanel({
  state,
  selectedRunId,
}: {
  readonly state: DetailState;
  readonly selectedRunId: string | undefined;
}): React.JSX.Element {
  if (state.kind === "idle") {
    return (
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Run detail</CardTitle>
          <CardDescription>Select a recorded request to inspect its timeline.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (state.kind === "loading") {
    return <DetailShell title="Run detail" description={`Loading ${state.runId}…`} />;
  }
  if (state.kind === "error") {
    return <DetailShell title="Run detail" description={state.message} tone="error" />;
  }

  return <RunDetail run={state.run} selectedRunId={selectedRunId} warnings={state.warnings} />;
}

function RunDetail({
  run,
  warnings,
}: {
  readonly run: RecordedRunDetail;
  readonly selectedRunId: string | undefined;
  readonly warnings: readonly string[];
}): React.JSX.Element {
  const summary = run.summary;
  const metadata = useMemo(() => runMetadata(summary), [summary]);
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3">
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate" title={summary.runId}>{summary.runId}</CardTitle>
            <CardDescription className="break-words">{summary.conversationId}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge variant={statusBadge(summary.status)}>{summary.status}</Badge>
            {summary.failureKind !== undefined ? <Badge variant="destructive">{summary.failureKind}</Badge> : null}
          </div>
        </div>
        <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <MetaItem label="Duration" value={formatDuration(summary.durationMs)} />
          <MetaItem label="Events" value={String(summary.eventCount)} />
          <MetaItem label="Updated" value={formatDate(summary.updatedAt)} />
          <MetaItem label="Usage/cost" value={summary.usage !== undefined || summary.cost !== undefined ? "present" : "not recorded"} />
        </dl>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {warnings.map((warning) => (
          <WarningNotice key={warning} warning={warning} />
        ))}
        {metadata.length > 0 ? (
          <details className="rounded-lg border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-sm font-medium">Summary metadata</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {metadata.map((entry) => (
                <div key={entry.label} className="min-w-0 rounded-md bg-background p-3 ring-1 ring-border">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{entry.label}</p>
                  <JsonPreview value={entry.value} />
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <EventTimeline events={run.events} />
      </CardContent>
    </Card>
  );
}

function EventTimeline({ events }: { readonly events: readonly RecordedRunEvent[] }): React.JSX.Element {
  if (events.length === 0) {
    return <StatusBox label="This run has no recorded events." />;
  }
  return (
    <div className="space-y-3" aria-label="Run event timeline">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Timeline</h3>
        <span className="text-xs text-muted-foreground">{events.length} loaded</span>
      </div>
      <ol className="space-y-3">
        {events.map((event) => (
          <EventRow key={`${event.index}-${event.type ?? event.category}`} event={event} />
        ))}
      </ol>
    </div>
  );
}

function EventRow({ event }: { readonly event: RecordedRunEvent }): React.JSX.Element {
  return (
    <li className="min-w-0 rounded-lg border border-border bg-background p-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={CATEGORY_BADGES[event.category]}>{event.category}</Badge>
            {event.type !== undefined ? <span className="font-mono text-xs text-muted-foreground">{event.type}</span> : null}
          </div>
          <p className="break-words text-sm font-medium">{event.label}</p>
          <p className="break-words text-sm text-muted-foreground">{event.summary}</p>
        </div>
        <div className="shrink-0 text-xs text-muted-foreground">
          #{event.index + 1}{event.timestamp !== undefined ? ` • ${formatDate(event.timestamp)}` : ""}
        </div>
      </div>
      <details className="mt-3 min-w-0 rounded-md bg-muted/40 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw JSON payload</summary>
        <div className="mt-2">
          <JsonPreview value={event.payload} />
        </div>
      </details>
    </li>
  );
}

function DetailShell({
  title,
  description,
  tone = "normal",
}: {
  readonly title: string;
  readonly description: string;
  readonly tone?: "normal" | "error";
}): React.JSX.Element {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className={tone === "error" ? "text-destructive" : undefined}>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function StatusBox({ label, tone = "normal" }: { readonly label: string; readonly tone?: "normal" | "error" }): React.JSX.Element {
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${tone === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/40 text-muted-foreground"}`}>
      {label}
    </div>
  );
}

function WarningNotice({ warning }: { readonly warning: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm [color:var(--warning)]">
      {warning}
    </div>
  );
}

function MetaItem({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
      <dt className="text-[0.7rem] uppercase tracking-wide">{label}</dt>
      <dd className="truncate text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function JsonPreview({ value }: { readonly value: unknown }): React.JSX.Element {
  return (
    <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function runMetadata(summary: RecordedRunListItem): readonly { readonly label: string; readonly value: unknown }[] {
  const entries: { label: string; value: unknown }[] = [];
  if (summary.usage !== undefined) {
    entries.push({ label: "Usage", value: summary.usage });
  }
  if (summary.cost !== undefined) {
    entries.push({ label: "Cost", value: summary.cost });
  }
  if (summary.providerSessionId !== undefined) {
    entries.push({ label: "Provider session", value: summary.providerSessionId });
  }
  if (summary.runtimeWarnings !== undefined) {
    entries.push({ label: "Runtime warnings", value: summary.runtimeWarnings });
  }
  if (summary.diagnostics !== undefined) {
    entries.push({ label: "Diagnostics", value: summary.diagnostics });
  }
  if (summary.capabilitiesUsed !== undefined) {
    entries.push({ label: "Capabilities", value: summary.capabilitiesUsed });
  }
  return entries;
}

function statusBadge(status: RecordedRunListItem["status"]): "success" | "destructive" | "warning" {
  if (status === "succeeded") {
    return "success";
  }
  if (status === "failed") {
    return "destructive";
  }
  return "warning";
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return "unknown";
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
