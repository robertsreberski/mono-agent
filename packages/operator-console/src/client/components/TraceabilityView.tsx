import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RecordedRunEvent,
  RecordedRunEventCategory,
  RecordedRunTimelineItem,
  RunSummaryStatus,
  TraceRunDetail,
  TraceRunListItem,
  TraceSourceHealth,
  TraceSourceListItem,
} from "@mono-agent/observability";
import { combineRecordedRunEvents } from "@mono-agent/observability/event-timeline";

import type {
  OperatorConsoleClient,
  TraceabilityRunsResponse,
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
import { Select } from "./ui/select.js";

interface TraceabilityViewProps {
  readonly client: OperatorConsoleClient;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly response: TraceabilityRunsResponse }
  | { readonly kind: "error"; readonly message: string };

type DetailState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly sourceId: string; readonly runId: string }
  | { readonly kind: "ready"; readonly detail: TraceRunDetail; readonly warnings: readonly string[] }
  | { readonly kind: "error"; readonly sourceId: string; readonly runId: string; readonly message: string };

type SelectedRunKey = `${string}/${string}`;
type StatusFilter = "all" | RunSummaryStatus;
type EventCounts = Record<RecordedRunEventCategory, number>;

interface OperationsSnapshot {
  readonly sourceCount: number;
  readonly runCount: number;
  readonly warningCount: number;
  readonly failingRunCount: number;
}

const CATEGORY_BADGES: Record<RecordedRunEventCategory, "default" | "secondary" | "outline" | "success" | "warning" | "destructive"> = {
  tool: "default",
  thinking: "warning",
  message: "secondary",
  runtime: "outline",
  error: "destructive",
};

const HEALTH_BADGES: Record<TraceSourceHealth, "success" | "warning" | "outline" | "destructive"> = {
  running: "success",
  stale: "warning",
  stopped: "outline",
  failed: "destructive",
};

export function TraceabilityView({ client }: TraceabilityViewProps): React.JSX.Element {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [selectedRunKey, setSelectedRunKey] = useState<SelectedRunKey | undefined>();
  const selectedRunKeyRef = useRef<SelectedRunKey | undefined>(undefined);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    selectedRunKeyRef.current = selectedRunKey;
  }, [selectedRunKey]);

  const loadDetail = useCallback(
    async (sourceId: string, runId: string): Promise<void> => {
      const key = runKey(sourceId, runId);
      selectedRunKeyRef.current = key;
      setSelectedRunKey(key);
      setDetailState({ kind: "loading", sourceId, runId });
      try {
        const response = await client.fetchTraceabilityRun(sourceId, runId);
        if (!response.enabled) {
          setDetailState({ kind: "error", sourceId, runId, message: "Traceability is disabled for this console." });
          return;
        }
        if (response.detail === undefined) {
          setDetailState({ kind: "error", sourceId, runId, message: "Trace run was not found." });
          return;
        }
        setDetailState({ kind: "ready", detail: response.detail, warnings: response.warnings ?? response.detail.run.warnings });
      } catch (error) {
        setDetailState({ kind: "error", sourceId, runId, message: errorMessage(error) });
      }
    },
    [client],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setListState({ kind: "loading" });
    try {
      const response = await client.fetchTraceabilityRuns();
      setListState({ kind: "ready", response });
      if (!response.enabled || response.runs.length === 0) {
        selectedRunKeyRef.current = undefined;
        setSelectedRunKey(undefined);
        setDetailState({ kind: "idle" });
      }
    } catch (error) {
      setListState({ kind: "error", message: errorMessage(error) });
      setDetailState({ kind: "idle" });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const listResponse = listState.kind === "ready" ? listState.response : undefined;
  const filteredRuns = useMemo(() => {
    const runs = listResponse?.runs ?? [];
    return runs.filter((run) => {
      const sourceMatches = sourceFilter === "all" || run.source.sourceId === sourceFilter;
      const statusMatches = statusFilter === "all" || run.status === statusFilter;
      return sourceMatches && statusMatches;
    });
  }, [listResponse?.runs, sourceFilter, statusFilter]);
  const snapshot = useMemo(
    () => listResponse === undefined ? undefined : operationsSnapshot(listResponse),
    [listResponse],
  );

  useEffect(() => {
    if (listState.kind !== "ready" || !listState.response.enabled) {
      return;
    }
    if (filteredRuns.length === 0) {
      selectedRunKeyRef.current = undefined;
      setSelectedRunKey(undefined);
      setDetailState({ kind: "idle" });
      return;
    }
    const currentKey = selectedRunKeyRef.current;
    if (currentKey !== undefined && filteredRuns.some((run) => runKey(run.source.sourceId, run.runId) === currentKey)) {
      return;
    }
    const next = filteredRuns[0];
    if (next !== undefined) {
      void loadDetail(next.source.sourceId, next.runId);
    }
  }, [filteredRuns, listState, loadDetail]);

  return (
    <section className="grid min-w-0 gap-4" aria-labelledby="traceability-title">
      <Card className="min-w-0 border border-border/70 shadow-sm">
        <CardHeader className="gap-4">
          <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0 space-y-1">
              <CardTitle id="traceability-title" className="text-lg">Traceability workbench</CardTitle>
              <CardDescription className="max-w-3xl">
                Live source health, run outcomes, warning signals, and event flow from local trace artifacts.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full md:w-auto"
              onClick={() => void refresh()}
              disabled={listState.kind === "loading"}
            >
              {listState.kind === "loading" ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
          {listResponse?.registryDir !== undefined ? (
            <p className="max-w-full break-all rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[0.7rem] text-muted-foreground" title={listResponse.registryDir}>
              {listResponse.registryDir}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="min-w-0 space-y-3">
          <ListStatus state={listState} />
          {listResponse?.enabled === true ? listResponse.warnings?.map((warning) => (
            <WarningNotice key={warning} warning={warning} />
          )) : null}
          {snapshot !== undefined && listResponse?.enabled === true ? (
            <OperationsOverview snapshot={snapshot} sources={listResponse.sources} />
          ) : null}
        </CardContent>
      </Card>

      {listResponse !== undefined && listResponse.enabled ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]">
          <aside className="grid min-w-0 content-start gap-4">
            <SourcesPanel sources={listResponse.sources} />
            <RunsPanel
              sources={listResponse.sources}
              runs={filteredRuns}
              allRunsCount={listResponse.runs.length}
              selectedRunKey={selectedRunKey}
              sourceFilter={sourceFilter}
              statusFilter={statusFilter}
              onSourceFilter={setSourceFilter}
              onStatusFilter={setStatusFilter}
              onSelect={(sourceId, runId) => void loadDetail(sourceId, runId)}
            />
          </aside>

          <RunDetailPanel state={detailState} />
        </div>
      ) : null}
    </section>
  );
}

function OperationsOverview({
  snapshot,
  sources,
}: {
  readonly snapshot: OperationsSnapshot;
  readonly sources: readonly TraceSourceListItem[];
}): React.JSX.Element {
  const healthCounts = countSources(sources);
  return (
    <div className="grid min-w-0 gap-3" aria-label="Operations snapshot">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Operations snapshot</h3>
        <span className="text-xs text-muted-foreground">{formatCount(snapshot.runCount, "run")} tracked</span>
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
          <MetricTile label="Sources" value={formatCount(snapshot.sourceCount, "source")} tone="neutral" />
          <MetricTile label="Runs" value={formatCount(snapshot.runCount, "run")} tone="neutral" />
          <MetricTile label="Warnings" value={formatCount(snapshot.warningCount, "warning")} tone={snapshot.warningCount > 0 ? "warning" : "neutral"} />
          <MetricTile label="Failures" value={formatCount(snapshot.failingRunCount, "failing")} tone={snapshot.failingRunCount > 0 ? "critical" : "neutral"} />
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Source health</h3>
            <span className="text-xs text-muted-foreground">{snapshot.sourceCount} total</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <HealthCount label="Running" value={healthCounts.running} tone="success" />
            <HealthCount label="Stale" value={healthCounts.stale} tone="warning" />
            <HealthCount label="Stopped" value={healthCounts.stopped} tone="muted" />
            <HealthCount label="Failed" value={healthCounts.failed} tone="critical" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SourcesPanel({ sources }: { readonly sources: readonly TraceSourceListItem[] }): React.JSX.Element {
  if (sources.length === 0) {
    return (
      <Card className="min-w-0 border border-border/70 shadow-sm">
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>Registered trace producers.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBox label="No agents have registered in this trace registry yet." />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="min-w-0 border border-border/70 shadow-sm">
      <CardHeader>
        <CardTitle>Sources</CardTitle>
        <CardDescription>Registered agents and artifact locations.</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="grid gap-2" aria-label="Trace sources">
        {sources.map((source) => (
          <div key={source.sourceId} className="min-w-0 rounded-lg border border-border bg-background p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium" title={source.label}>{source.label}</p>
                <p className="break-all font-mono text-[0.7rem] text-muted-foreground" title={source.sourceId}>{source.sourceId}</p>
              </div>
              <Badge variant={HEALTH_BADGES[source.health]}>{source.health}</Badge>
            </div>
            <p className="mt-2 break-all font-mono text-[0.7rem] text-muted-foreground" title={source.artifactDir}>{source.artifactDir}</p>
            {source.transports !== undefined && source.transports.length > 0 ? (
              <p className="mt-2 break-words text-[0.7rem] text-muted-foreground">{source.transports.join(", ")}</p>
            ) : null}
            {source.warnings.map((warning) => (
              <p key={warning} className="mt-2 text-[0.7rem] [color:var(--warning)]">{warning}</p>
            ))}
          </div>
        ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RunsPanel({
  sources,
  runs,
  allRunsCount,
  selectedRunKey,
  sourceFilter,
  statusFilter,
  onSourceFilter,
  onStatusFilter,
  onSelect,
}: {
  readonly sources: readonly TraceSourceListItem[];
  readonly runs: readonly TraceRunListItem[];
  readonly allRunsCount: number;
  readonly selectedRunKey: SelectedRunKey | undefined;
  readonly sourceFilter: string;
  readonly statusFilter: StatusFilter;
  readonly onSourceFilter: (value: string) => void;
  readonly onStatusFilter: (value: StatusFilter) => void;
  readonly onSelect: (sourceId: string, runId: string) => void;
}): React.JSX.Element {
  return (
    <Card className="min-w-0 border border-border/70 shadow-sm">
      <CardHeader className="gap-3">
        <div className="min-w-0">
          <CardTitle>Run queue</CardTitle>
          <CardDescription>{formatCount(allRunsCount, "run")} sorted by latest artifact update.</CardDescription>
        </div>
        <RunFilters
          sources={sources}
          sourceFilter={sourceFilter}
          statusFilter={statusFilter}
          onSourceFilter={onSourceFilter}
          onStatusFilter={onStatusFilter}
        />
      </CardHeader>
      <CardContent className="min-w-0">
        {allRunsCount === 0 ? (
          <StatusBox label="No runs have been recorded yet." />
        ) : null}
        {allRunsCount > 0 && runs.length === 0 ? (
          <StatusBox label="No runs match the current filters." />
        ) : null}
        {runs.length > 0 ? (
          <RunList runs={runs} selectedRunKey={selectedRunKey} onSelect={onSelect} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RunFilters({
  sources,
  sourceFilter,
  statusFilter,
  onSourceFilter,
  onStatusFilter,
}: {
  readonly sources: readonly TraceSourceListItem[];
  readonly sourceFilter: string;
  readonly statusFilter: StatusFilter;
  readonly onSourceFilter: (value: string) => void;
  readonly onStatusFilter: (value: StatusFilter) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        Source
        <Select aria-label="Source" value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)}>
          <option value="all">All sources</option>
          {sources.map((source) => (
            <option key={source.sourceId} value={source.sourceId}>{source.label}</option>
          ))}
        </Select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        Status
        <Select aria-label="Status" value={statusFilter} onChange={(event) => onStatusFilter(event.target.value as StatusFilter)}>
          <option value="all">All statuses</option>
          <option value="running">running</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </Select>
      </label>
    </div>
  );
}

function ListStatus({ state }: { readonly state: ListState }): React.JSX.Element | null {
  if (state.kind === "loading") {
    return <StatusBox label="Loading traceability data..." />;
  }
  if (state.kind === "error") {
    return <StatusBox tone="error" label={state.message} />;
  }
  if (!state.response.enabled) {
    return <StatusBox label={state.response.warnings?.[0] ?? "Traceability is disabled."} />;
  }
  return null;
}

function RunList({
  runs,
  selectedRunKey,
  onSelect,
}: {
  readonly runs: readonly TraceRunListItem[];
  readonly selectedRunKey: SelectedRunKey | undefined;
  readonly onSelect: (sourceId: string, runId: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2" aria-label="Trace runs">
      {runs.map((run) => {
        const key = runKey(run.source.sourceId, run.runId);
        const selected = key === selectedRunKey;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(run.source.sourceId, run.runId)}
            className={`min-w-0 rounded-lg border p-3 text-left transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${selected ? "border-primary bg-primary/5" : "border-border bg-background"}`}
            aria-pressed={selected}
          >
            <div className="flex min-w-0 flex-col gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant={statusBadge(run.status)}>{run.status}</Badge>
                  <Badge variant={HEALTH_BADGES[run.source.health]}>{run.source.label}</Badge>
                  {run.failureKind !== undefined ? <Badge variant="destructive">{run.failureKind}</Badge> : null}
                </div>
                <p className="truncate font-mono text-xs text-foreground" title={run.runId}>{run.runId}</p>
                <p className="truncate text-xs text-muted-foreground" title={run.conversationId}>{run.conversationId}</p>
              </div>
              <div className="grid gap-2 text-[0.7rem] text-muted-foreground min-[360px]:grid-cols-2">
                <RunMiniStat label="Duration" value={formatDuration(run.durationMs)} />
                <RunMiniStat label="Events" value={formatCount(run.eventCount, "event")} />
                <RunMiniStat label="Updated" value={formatDate(run.updatedAt)} />
                <RunMiniStat
                  label="Signals"
                  value={[
                    run.usage !== undefined || run.cost !== undefined ? "usage" : undefined,
                    run.capabilitiesUsed !== undefined ? "capabilities" : undefined,
                  ].filter((value): value is string => value !== undefined).join(", ") || "basic"}
                />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function RunDetailPanel({ state }: { readonly state: DetailState }): React.JSX.Element {
  if (state.kind === "idle") {
    return (
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Run detail</CardTitle>
          <CardDescription>Select a run to inspect its source metadata and timeline.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (state.kind === "loading") {
    return <DetailShell title="Run detail" description={`Loading ${state.sourceId}/${state.runId}...`} />;
  }
  if (state.kind === "error") {
    return <DetailShell title="Run detail" description={state.message} tone="error" />;
  }
  return <RunDetail detail={state.detail} warnings={state.warnings} />;
}

function RunDetail({
  detail,
  warnings,
}: {
  readonly detail: TraceRunDetail;
  readonly warnings: readonly string[];
}): React.JSX.Element {
  const summary = detail.run.summary;
  const metadata = useMemo(() => runMetadata(summary), [summary]);
  const eventCounts = useMemo(() => countEvents(detail.run.events), [detail.run.events]);
  return (
    <Card className="min-w-0 border border-border/70 shadow-sm">
      <CardHeader className="gap-3">
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate" title={summary.runId}>{summary.runId}</CardTitle>
            <CardDescription className="break-words">{detail.source.label} - {summary.conversationId}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1">
            <Badge variant={statusBadge(summary.status)}>{summary.status}</Badge>
            <Badge variant={HEALTH_BADGES[detail.source.health]}>{detail.source.health}</Badge>
            {summary.failureKind !== undefined ? <Badge variant="destructive">{summary.failureKind}</Badge> : null}
          </div>
        </div>
        <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <MetaItem label="Duration" value={formatDuration(summary.durationMs)} />
          <MetaItem label="Events" value={String(summary.eventCount)} />
          <MetaItem label="Updated" value={formatDate(summary.updatedAt)} />
          <MetaItem label="Source" value={detail.source.sourceId} />
        </dl>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {warnings.map((warning) => (
          <WarningNotice key={warning} warning={warning} />
        ))}
        <EventMixPanel counts={eventCounts} />
        <details className="rounded-lg border border-border bg-muted/30 p-3">
          <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">Source metadata</summary>
          <div className="mt-3">
            <JsonPreview value={detail.source} />
          </div>
        </details>
        {metadata.length > 0 ? (
          <details className="rounded-lg border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">Summary metadata</summary>
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
        <EventTimeline events={detail.run.events} />
      </CardContent>
    </Card>
  );
}

function EventTimeline({ events }: { readonly events: readonly RecordedRunEvent[] }): React.JSX.Element {
  const timelineItems = useMemo(() => combineRecordedRunEvents(events), [events]);
  if (events.length === 0) {
    return <StatusBox label="This run has no recorded events." />;
  }
  const countLabel = timelineItems.length === events.length
    ? `${events.length} loaded`
    : `${timelineItems.length} rows from ${events.length} events`;
  return (
    <div className="space-y-3" aria-label="Run event timeline">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Timeline</h3>
        <span className="text-xs text-muted-foreground">{countLabel}</span>
      </div>
      <ol className="space-y-3">
        {timelineItems.map((event) => (
          <EventRow key={`${event.index}-${event.type ?? event.category}`} event={event} />
        ))}
      </ol>
    </div>
  );
}

function EventRow({ event }: { readonly event: RecordedRunTimelineItem }): React.JSX.Element {
  const isGrouped = event.sourceEventCount > 1;
  const sourceRange = isGrouped
    ? `#${event.sourceEventStartIndex + 1}-#${event.sourceEventEndIndex + 1} · ${event.sourceEventCount} events`
    : `#${event.index + 1}`;
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
          {sourceRange}{event.timestamp !== undefined ? ` - ${formatDate(event.timestamp)}` : ""}
        </div>
      </div>
      <details className="mt-3 min-w-0 rounded-md bg-muted/40 p-3">
        <summary className="cursor-pointer rounded-sm text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{isGrouped ? "Combined payload preview" : "Raw JSON payload"}</summary>
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

function MetricTile({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "neutral" | "warning" | "critical";
}): React.JSX.Element {
  const toneClass = tone === "critical"
    ? "border-destructive/30 bg-destructive/10 [color:var(--destructive)]"
    : tone === "warning"
      ? "border-warning/30 bg-warning/10 [color:var(--warning)]"
      : "border-border bg-background text-foreground";
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[0.7rem] uppercase text-muted-foreground">{label}</p>
      <p className="truncate text-lg font-medium" title={value}>{value}</p>
    </div>
  );
}

function HealthCount({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: "success" | "warning" | "muted" | "critical";
}): React.JSX.Element {
  const dotClass = tone === "success"
    ? "bg-success"
    : tone === "warning"
      ? "bg-warning"
      : tone === "critical"
        ? "bg-destructive"
        : "bg-muted-foreground";
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        <span className="truncate text-muted-foreground">{label}</span>
      </span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function RunMiniStat({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-2 py-1.5">
      <p className="uppercase text-muted-foreground">{label}</p>
      <p className="truncate font-medium text-foreground" title={value}>{value}</p>
    </div>
  );
}

function EventMixPanel({ counts }: { readonly counts: EventCounts }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-muted/20 p-3" aria-label="Event mix">
      <div className="mb-3 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-medium">Event mix</h3>
        <span className="text-xs text-muted-foreground">{formatCount(totalEvents(counts), "event")} recorded</span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <EventMixItem label="thinking" value={counts.thinking} variant="warning" />
        <EventMixItem label="tool" value={counts.tool} variant="default" />
        <EventMixItem label="message" value={counts.message} variant="secondary" />
        <EventMixItem label="runtime" value={counts.runtime} variant="outline" />
        <EventMixItem label="error" value={counts.error} variant="destructive" />
      </div>
    </section>
  );
}

function EventMixItem({
  label,
  value,
  variant,
}: {
  readonly label: string;
  readonly value: number;
  readonly variant: "default" | "secondary" | "outline" | "warning" | "destructive";
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-background px-2 py-2">
      <Badge variant={variant}>{formatCount(value, label)}</Badge>
    </div>
  );
}

function StatusBox({ label, tone = "normal" }: { readonly label: string; readonly tone?: "normal" | "error" }): React.JSX.Element {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`rounded-lg border px-3 py-2 text-sm ${tone === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/40 text-muted-foreground"}`}
    >
      {label}
    </div>
  );
}

function WarningNotice({ warning }: { readonly warning: string }): React.JSX.Element {
  return (
    <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm [color:var(--warning)]">
      {warning}
    </div>
  );
}

function MetaItem({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
      <dt className="text-[0.7rem] uppercase">{label}</dt>
      <dd className="truncate text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function JsonPreview({ value }: { readonly value: unknown }): React.JSX.Element {
  return (
    <pre
      tabIndex={0}
      aria-label="JSON payload preview"
      className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function countSources(sources: readonly TraceSourceListItem[]): Record<TraceSourceHealth, number> {
  return sources.reduce<Record<TraceSourceHealth, number>>((counts, source) => {
    counts[source.health] += 1;
    return counts;
  }, { running: 0, stale: 0, stopped: 0, failed: 0 });
}

function operationsSnapshot(response: TraceabilityRunsResponse): OperationsSnapshot {
  const sourceWarnings = response.sources.reduce((count, source) => count + source.warnings.length, 0);
  return {
    sourceCount: response.sources.length,
    runCount: response.runs.length,
    warningCount: sourceWarnings + (response.warnings?.length ?? 0),
    failingRunCount: response.runs.filter((run) => run.status === "failed").length,
  };
}

function countEvents(events: readonly RecordedRunEvent[]): EventCounts {
  return events.reduce<EventCounts>((counts, event) => {
    counts[event.category] += 1;
    return counts;
  }, { tool: 0, thinking: 0, message: 0, runtime: 0, error: 0 });
}

function totalEvents(counts: EventCounts): number {
  return counts.tool + counts.thinking + counts.message + counts.runtime + counts.error;
}

function formatCount(count: number, singular: string): string {
  if (singular === "thinking" || singular === "runtime" || singular === "failing") {
    return `${count} ${singular}`;
  }
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function runMetadata(summary: TraceRunDetail["run"]["summary"]): readonly { readonly label: string; readonly value: unknown }[] {
  const entries: { label: string; value: unknown }[] = [];
  if (summary.startedAt !== undefined) {
    entries.push({ label: "Started at", value: summary.startedAt });
  }
  if (summary.endedAt !== undefined) {
    entries.push({ label: "Ended at", value: summary.endedAt });
  }
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

function statusBadge(status: RunSummaryStatus): "success" | "destructive" | "warning" {
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

function runKey(sourceId: string, runId: string): SelectedRunKey {
  return `${sourceId}/${runId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
