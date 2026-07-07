/**
 * The session store + orchestrator behind the web operator surface. It folds two
 * sources into one per-instance session model, keyed by `sourceId + runId` at
 * the browser boundary and by `runId` inside each instance state (the finished
 * on-disk artifact is authoritative):
 *
 *  - **Recorded history**: seeded from each instance's artifact dir on discovery,
 *    then refreshed by watching that dir for changed `*.summary.json` files.
 *  - **Live sub-runs**: streamed from each running instance's operator-adapter live SSE
 *    endpoint (over HTTP) and folded frame-by-frame into a provisional session
 *    that firms up when the run finishes.
 *
 * Instance membership itself is reconciled from the trace-source registry — both
 * `fs.watch` (fast, best-effort) and a periodic timer (the reliable source of
 * truth). All state changes fan out to browser subscribers as
 * {@link BrowserStreamFrame}s.
 */
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

import type { RunEventFrame } from "@mono-agent/agent-contracts";
import { mapRunToSession } from "@mono-agent/observability";
import type { RunSummary, RunSummaryStatus, RuntimeEventLike } from "@mono-agent/observability";

import { discoverWebInstances, resolveLiveApiKey } from "./discovery.js";
import type { DiscoveredWebInstance } from "./discovery.js";
import {
  listInstanceSessionSummaries,
  listInstanceSessionSummaryPage,
  projectStaleRunningSession,
  readInstanceSession,
  readInstanceSessionSummaryByFileName,
} from "./history.js";
import type { DiskRunSignature, SourceStampedSession, SourceStampedSessionSummary } from "./history.js";
import { connectLiveStream } from "./live-client.js";
import type { LiveStreamConnection, LiveStreamStatus } from "./live-client.js";
import type { BrowserStreamFrame, WebInstance } from "./session-model.js";

/** On-disk recorded-run summary suffix (observability's `SUMMARY_SUFFIX`, not exported). */
const SUMMARY_SUFFIX = ".summary.json";
const MEMORY_ARTIFACT_NAMESPACE = "memory";
const MAX_SUPPRESSED_MEMORY_LIVE_RUNS = 512;

const RUN_SUMMARY_STATUSES = new Set<RunSummaryStatus>([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface SessionAggregatorLogger {
  info?(message: string, metadata?: unknown): void;
  warn?(message: string, metadata?: unknown): void;
  error?(message: string, metadata?: unknown): void;
}

export interface SessionAggregatorOptions {
  readonly registryDirs: readonly string[];
  readonly maxRunsPerInstance: number;
  readonly staleAfterMs?: number;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: SessionAggregatorLogger;
  /** Periodic registry reconcile interval (source of truth for membership). Default 5000. */
  readonly reconcileIntervalMs?: number;
  /** Debounce for `fs.watch`-triggered registry reconciles. Default 300. */
  readonly registryDebounceMs?: number;
  /** Debounce for `fs.watch`-triggered artifact re-reads (per run). Default 300. */
  readonly artifactDebounceMs?: number;
  /** Debounce for live-fold recomputes (per run). Default 150. */
  readonly liveFoldDebounceMs?: number;
  /** Coalescing window for `instances` frame emissions. Default 100. */
  readonly instancesDebounceMs?: number;
  /** Injectable fetch, threaded to the live client (tests point it at a local SSE server). */
  readonly fetchImpl?: typeof fetch;
  /** Include memory-maintenance runs in disk history and live frames. Default false. */
  readonly includeMemory?: boolean;
  /** Injectable clock for stale-running projection. Defaults to Date.now. */
  readonly clock?: () => number;
}

/** Per-run live-fold state: the running summary + the ordered events folded so far. */
interface LiveRunState {
  summary: RunSummary;
  readonly events: RuntimeEventLike[];
  readonly seenEventKeys: Set<string>;
}

interface LiveState {
  readonly conn: LiveStreamConnection;
  readonly runs: Map<string, LiveRunState>;
  readonly recomputeTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface InstanceState {
  discovered: DiscoveredWebInstance;
  readonly sessions: Map<string, SourceStampedSession>;
  liveConnected: boolean;
  live: LiveState | undefined;
  artifactWatcher: FSWatcher | undefined;
  memoryArtifactWatcher: FSWatcher | undefined;
  readonly artifactTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Last observed summary-file signature per retained disk run. */
  readonly diskRunSignatures: Map<string, DiskRunSignature>;
  /** Runs whose cached session contains full detail read from the disk artifact. */
  readonly detailLoaded: Set<string>;
  /** Per-instance cap on retained sessions (mirrors {@link SessionAggregator.maxRunsPerInstance}). */
  readonly maxRunsPerInstance: number;
  /**
   * Runs materialized from their finished (terminal) on-disk artifact. The disk
   * artifact is authoritative: once a runId is here, live folds must not overwrite
   * it with a mid-run/truncated view (last write wins in favour of disk).
   */
  readonly artifactFinished: Set<string>;
  /**
   * Runs whose live stream already delivered `run_finished`. A late/replayed live
   * frame (SSE reconnect/replay) for such a run must not resurrect it as a fresh
   * "running" state and overwrite the finished session. Distinct from
   * {@link artifactFinished} (disk) so a later authoritative disk read still wins.
   */
  readonly liveFinished: Set<string>;
  /** Memory runs recently identified on the live stream and suppressed while includeMemory is false. */
  readonly suppressedMemoryLiveRuns: BoundedStringFifoSet;
}

export class SessionAggregator {
  private readonly registryDirs: readonly string[];
  private readonly maxRunsPerInstance: number;
  private readonly staleAfterMs: number | undefined;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly logger: SessionAggregatorLogger | undefined;
  private readonly reconcileIntervalMs: number;
  private readonly registryDebounceMs: number;
  private readonly artifactDebounceMs: number;
  private readonly liveFoldDebounceMs: number;
  private readonly instancesDebounceMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly includeMemory: boolean;
  private readonly clock: () => number;

  private readonly states = new Map<string, InstanceState>();
  private readonly subscribers = new Set<(frame: BrowserStreamFrame) => void>();
  private readonly registryWatchers: FSWatcher[] = [];
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private reconcileDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private instancesEmitTimer: ReturnType<typeof setTimeout> | undefined;
  private lifecycleGeneration = 0;
  private stopped = false;

  constructor(options: SessionAggregatorOptions) {
    this.registryDirs = options.registryDirs;
    this.maxRunsPerInstance = options.maxRunsPerInstance;
    this.staleAfterMs = options.staleAfterMs;
    this.env = options.env;
    this.logger = options.logger;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.registryDebounceMs = options.registryDebounceMs ?? 300;
    this.artifactDebounceMs = options.artifactDebounceMs ?? 300;
    this.liveFoldDebounceMs = options.liveFoldDebounceMs ?? 150;
    this.instancesDebounceMs = options.instancesDebounceMs ?? 100;
    this.fetchImpl = options.fetchImpl;
    this.includeMemory = options.includeMemory === true;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Discover instances, seed history, open live connections, and start watching. */
  async start(): Promise<void> {
    this.stopped = false;
    const generation = ++this.lifecycleGeneration;
    const discovered = await this.discover();
    if (!this.isActive(generation)) {
      return;
    }
    for (const instance of discovered) {
      await this.addInstance(instance, { emitSessions: false }, generation);
      if (!this.isActive(generation)) {
        return;
      }
    }
    if (!this.isActive(generation)) {
      return;
    }
    this.setupRegistryWatchers();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  getInstances(): WebInstance[] {
    return [...this.states.values()].map((state) => this.projectInstance(state));
  }

  /** Sessions for one instance (by sourceId) or all ("all"), newest-first by `startTs`. */
  getSessions(filter: string): SourceStampedSession[] {
    this.refreshStaleRunningSessions(filter, { emit: false });
    return this.collectSessions(filter);
  }

  /** Step-less list projection for `/api/sessions` and browser SSE snapshots. */
  getSessionSummaries(filter: string): SourceStampedSession[] {
    this.refreshStaleRunningSessions(filter, { emit: false });
    return this.collectSessions(filter).map((session) => toBrowserListSession(session));
  }

  async getSessionSummariesPage(
    filter: string,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ readonly sessions: readonly SourceStampedSession[]; readonly total: number; readonly offset: number; readonly limit: number; readonly hasMore: boolean }> {
    this.refreshStaleRunningSessions(filter, { emit: false });
    const states = this.filteredStates(filter);
    if (states.length === 0 || page.limit === 0) {
      const total = await this.countPagedSessions(states, Math.max(1, page.offset + page.limit));
      return { sessions: [], total, offset: page.offset, limit: page.limit, hasMore: total > page.offset };
    }
    const maxRuns = page.offset + page.limit;
    const pages = await Promise.all(
      states.map(async (state) => {
        const result = await listInstanceSessionSummaryPage(state.discovered, {
          maxRuns,
          includeMemory: this.includeMemory,
          nowMs: this.now(),
        });
        return { state, result };
      }),
    );
    const sessions = pages
      .flatMap(({ state, result }) =>
        result.summaries.map((entry) => {
          const cached = state.sessions.get(entry.session.id);
          return cached === undefined
            ? entry.session
            : projectStaleRunningSession(mergeSessionPreservingVisibleDetail(cached, entry.session), this.now());
        }),
      )
      .sort((left, right) => startMs(right.startTs) - startMs(left.startTs));
    const total = pages.reduce((sum, pageResult) => sum + pageResult.result.total, 0);
    return {
      sessions: sessions.slice(page.offset, page.offset + page.limit).map((session) => toBrowserListSession(session)),
      total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.offset + page.limit < total,
    };
  }

  private collectSessions(filter: string): SourceStampedSession[] {
    return this.filteredStates(filter)
      .flatMap((state) => [...state.sessions.values()])
      .sort((left, right) => startMs(right.startTs) - startMs(left.startTs));
  }

  /** One session, reading it from disk on demand when it isn't already held. */
  async getSession(sourceId: string, runId: string): Promise<SourceStampedSession | undefined> {
    const state = this.states.get(sourceId);
    if (state === undefined) {
      return undefined;
    }
    this.refreshStaleRunningSessionsForState(state, { emit: false });
    const existing = state.sessions.get(runId);
    const diskSignature = state.diskRunSignatures.get(runId);
    if (
      existing !== undefined &&
      (state.detailLoaded.has(runId) ||
        diskSignature === undefined ||
        (diskSignature.status === "running" && state.liveFinished.has(runId)))
    ) {
      return existing;
    }
    let session: SourceStampedSession | undefined;
    try {
      session = await readInstanceSession(state.discovered, runId, { includeMemory: this.includeMemory, nowMs: this.now() });
    } catch (error) {
      this.logger?.warn?.("Failed to read session on demand.", { sourceId, runId, error: errorMessage(error) });
      return existing;
    }
    if (session !== undefined && this.isCurrentState(state)) {
      this.insertDiskSession(state, runId, session, { emit: false, detailLoaded: true });
      return state.sessions.get(runId) ?? session;
    }
    return session ?? existing;
  }

  /** Subscribe to the browser frame fan-out. Returns an unsubscribe function. */
  subscribe(listener: (frame: BrowserStreamFrame) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Close every live connection, watcher, and timer, and drop all subscribers. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    if (this.reconcileTimer !== undefined) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.reconcileDebounceTimer !== undefined) {
      clearTimeout(this.reconcileDebounceTimer);
      this.reconcileDebounceTimer = undefined;
    }
    if (this.instancesEmitTimer !== undefined) {
      clearTimeout(this.instancesEmitTimer);
      this.instancesEmitTimer = undefined;
    }
    for (const watcher of this.registryWatchers) {
      watcher.close();
    }
    this.registryWatchers.length = 0;
    for (const state of this.states.values()) {
      this.teardownState(state);
    }
    this.states.clear();
    this.subscribers.clear();
  }

  private async discover(): Promise<readonly DiscoveredWebInstance[]> {
    return discoverWebInstances({
      registryDirs: this.registryDirs,
      ...(this.staleAfterMs === undefined ? {} : { staleAfterMs: this.staleAfterMs }),
      ...(this.env === undefined ? {} : { env: this.env }),
    });
  }

  private async addInstance(
    discovered: DiscoveredWebInstance,
    options: { readonly emitSessions: boolean },
    generation = this.lifecycleGeneration,
  ): Promise<void> {
    const state: InstanceState = {
      discovered,
      sessions: new Map(),
      liveConnected: false,
      live: undefined,
      artifactWatcher: undefined,
      memoryArtifactWatcher: undefined,
      artifactTimers: new Map(),
      diskRunSignatures: new Map(),
      detailLoaded: new Set(),
      maxRunsPerInstance: this.maxRunsPerInstance,
      artifactFinished: new Set(),
      liveFinished: new Set(),
      suppressedMemoryLiveRuns: new BoundedStringFifoSet(MAX_SUPPRESSED_MEMORY_LIVE_RUNS),
    };
    this.states.set(discovered.instance.sourceId, state);

    try {
      await this.seedHistory(state, { emitSessions: false });
    } catch (error) {
      this.logger?.warn?.("Failed to seed instance history.", {
        sourceId: discovered.instance.sourceId,
        error: errorMessage(error),
      });
    }
    if (!this.isCurrentState(state, generation)) {
      this.teardownState(state);
      return;
    }

    this.watchArtifacts(state);
    await this.connectLive(state, generation);
    if (!this.isCurrentState(state, generation)) {
      this.teardownState(state);
      return;
    }

    if (options.emitSessions) {
      for (const session of state.sessions.values()) {
        this.emit({ t: "session_upsert", session });
      }
    }
    this.scheduleInstancesEmit();
  }

  private async connectLive(state: InstanceState, generation = this.lifecycleGeneration): Promise<void> {
    const baseUrl = state.discovered.liveBaseUrl;
    if (baseUrl === undefined) {
      return;
    }
    const apiKey = await resolveLiveApiKey(state.discovered, this.env);
    if (!this.isCurrentState(state, generation)) {
      return;
    }
    const conn = connectLiveStream({
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      onFrame: (frame) => this.handleLiveFrame(state, frame),
      onStatus: (status) => this.handleLiveStatus(state, status),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    if (!this.isCurrentState(state, generation)) {
      conn.close();
      return;
    }
    state.live = { conn, runs: new Map(), recomputeTimers: new Map() };
  }

  private disconnectLive(state: InstanceState): void {
    const live = state.live;
    if (live === undefined) {
      return;
    }
    live.conn.close();
    for (const timer of live.recomputeTimers.values()) {
      clearTimeout(timer);
    }
    live.recomputeTimers.clear();
    live.runs.clear();
    state.live = undefined;
    if (state.liveConnected) {
      state.liveConnected = false;
      this.scheduleInstancesEmit();
    }
  }

  private handleLiveStatus(state: InstanceState, status: LiveStreamStatus): void {
    if (state.live === undefined || !this.isCurrentState(state)) {
      return;
    }
    const connected = status === "connected";
    if (state.liveConnected !== connected) {
      state.liveConnected = connected;
      this.scheduleInstancesEmit();
    }
  }

  private handleLiveFrame(state: InstanceState, frame: RunEventFrame): void {
    const live = state.live;
    if (live === undefined || !this.isCurrentState(state)) {
      return;
    }
    if (frame.sourceId !== state.discovered.instance.sourceId) {
      return;
    }
    if (!this.includeMemory && this.shouldDropMemoryLiveFrame(state, frame)) {
      this.suppressMemoryLiveRun(state, frame.runId);
      return;
    }
    // A run that already finished (live) or was materialized from its terminal
    // disk artifact must not be resurrected by a late/replayed non-terminal frame.
    if (state.liveFinished.has(frame.runId) || state.artifactFinished.has(frame.runId)) {
      return;
    }
    if (frame.t === "run_started") {
      // `run_started` may arrive *after* `event` frames (viewer connected mid-run,
      // or the frame was reordered): keep any already-folded events, but adopt the
      // authoritative conversationId/source/startedAt this frame carries.
      const existing = live.runs.get(frame.runId);
      if (existing === undefined) {
        live.runs.set(frame.runId, { summary: runningSummaryFromStart(frame), events: [], seenEventKeys: new Set() });
      } else {
        existing.summary = runningSummaryFromStart(frame);
      }
      this.scheduleLiveRecompute(state, frame.runId);
      return;
    }
    if (frame.t === "event") {
      let run = live.runs.get(frame.runId);
      if (run === undefined) {
        run = { summary: runningSummaryFromEvent(frame), events: [], seenEventKeys: new Set() };
        live.runs.set(frame.runId, run);
      }
      const eventKey = liveEventKey(frame);
      if (eventKey !== undefined) {
        if (run.seenEventKeys.has(eventKey)) {
          return;
        }
        run.seenEventKeys.add(eventKey);
      }
      run.events.push(coerceRuntimeEvent(frame.event));
      this.scheduleLiveRecompute(state, frame.runId);
      return;
    }
    // run_finished is terminal: fold once with the authoritative summary (cancelling
    // any pending debounced recompute), then drop the run's live state so its
    // `events[]` aren't retained for the lifetime of the process.
    const run = live.runs.get(frame.runId);
    let summary = coerceRunSummary(frame.summary) ?? run?.summary ?? finishedSummary(frame.runId, frame.status);
    if (run !== undefined) {
      // Preserve conversationId/startedAt/source a live placeholder already learned
      // but a sparse `run_finished.summary` may omit.
      summary = backfillRunningSummary(summary, run.summary);
    }
    const events = run?.events ?? [];
    const pending = live.recomputeTimers.get(frame.runId);
    if (pending !== undefined) {
      clearTimeout(pending);
      live.recomputeTimers.delete(frame.runId);
    }
    this.recomputeLiveRun(state, frame.runId, summary, events);
    live.runs.delete(frame.runId);
    // Mark terminal so a late/replayed frame can't rebuild it as "running".
    state.liveFinished.add(frame.runId);
  }

  private scheduleLiveRecompute(state: InstanceState, runId: string): void {
    const live = state.live;
    if (live === undefined || live.recomputeTimers.has(runId)) {
      return;
    }
    const timer = setTimeout(() => {
      live.recomputeTimers.delete(runId);
      const run = live.runs.get(runId);
      if (run !== undefined) {
        this.recomputeLiveRun(state, runId, run.summary, run.events);
      }
    }, this.liveFoldDebounceMs);
    timer.unref?.();
    live.recomputeTimers.set(runId, timer);
  }

  private recomputeLiveRun(
    state: InstanceState,
    runId: string,
    summary: RunSummary,
    events: readonly RuntimeEventLike[],
  ): void {
    if (!this.isCurrentState(state)) {
      return;
    }
    // The finished on-disk artifact is authoritative: once a run has been
    // materialized from its terminal artifact, a late/mid-run live fold must not
    // clobber it with a truncated view (a viewer that connected mid-run misses the
    // early events). Skip the overwrite entirely for such runs.
    if (state.artifactFinished.has(runId)) {
      return;
    }
    const sourceId = state.discovered.instance.sourceId;
    const session: SourceStampedSession = { ...mapRunToSession(summary, events, this.mapOptions(state)), sourceId };
    this.insertSession(state, runId, session, { emit: true });
  }

  private insertDiskSession(
    state: InstanceState,
    runId: string,
    session: SourceStampedSession,
    options: { readonly emit: boolean; readonly detailLoaded: boolean },
  ): void {
    const existing = state.sessions.get(runId);
    const nextSession =
      existing !== undefined && state.liveFinished.has(runId)
        ? mergeSessionPreservingVisibleDetail(existing, session)
        : session;
    if (isTerminalSessionStatus(nextSession.status)) {
      state.artifactFinished.add(runId);
    }
    if (options.detailLoaded || sessionHasVisibleDetail(nextSession)) {
      state.detailLoaded.add(runId);
    }
    this.insertSession(state, runId, nextSession, options);
  }

  private insertDiskSummarySession(
    state: InstanceState,
    entry: SourceStampedSessionSummary,
    options: { readonly emit: boolean },
  ): void {
    const runId = entry.session.id;
    const previousSignature = state.diskRunSignatures.get(runId);
    const existing = state.sessions.get(runId);
    const nextSession =
      existing !== undefined ? mergeSessionPreservingVisibleDetail(existing, entry.session) : entry.session;
    if (!diskRunSignatureEquals(previousSignature, entry.signature)) {
      state.detailLoaded.delete(runId);
    }
    state.diskRunSignatures.set(runId, entry.signature);
    if (isTerminalSessionStatus(entry.signature.status)) {
      state.artifactFinished.add(runId);
    }
    this.insertSession(state, runId, nextSession, { emit: false });
    if (options.emit) {
      this.emit({ t: "session_upsert", session: toBrowserListSession(nextSession) });
    }
  }

  private insertSession(
    state: InstanceState,
    runId: string,
    session: SourceStampedSession,
    options: { readonly emit: boolean },
  ): void {
    const projected = projectStaleRunningSession(session, this.now());
    state.sessions.set(runId, projected);
    this.evictSessionOverflow(state, runId);
    if (options.emit) {
      this.emit({ t: "session_upsert", session: projected });
    }
    this.scheduleInstancesEmit();
  }

  /**
   * Bound `state.sessions` to the per-instance cap, evicting the oldest *completed*
   * sessions by `startTs`. A still-running session is never evicted (its live fold
   * is in flight).
   *
   * Eviction is deliberately SILENT — it emits no `session_removed`. This map is a
   * bounded live-fold working set, not the history source: an evicted run still
   * exists on disk and stays reachable via disk paging (`getSessionSummariesPage`)
   * and the detail endpoint. Broadcasting a removal here would delete rows from
   * browsers that legitimately hold more than the cap (the initial snapshot's tail
   * or runs paged in from disk), conflating "evicted from memory" with "gone".
   * `session_removed` is reserved for genuine removal/invalidation (instance gone,
   * artifact dir moved, memory-run suppression).
   *
   * KEEP DECISION (#166, follow-up from #162): because the genuine-removal paths
   * ({@link removeInstance}, the artifact-dir-move reseed, memory-run suppression)
   * iterate only `state.sessions`, a run that was already cap-evicted receives NO
   * `session_removed` if it is later genuinely deleted — a browser still showing it
   * (from its snapshot/paged history) self-heals on RELOAD, when the fresh
   * disk-backed snapshot no longer contains it. Closing this window "live" would
   * mean either retaining evicted ids unbounded (defeating the cap) or a disk probe
   * per removal (perf) — both architecture changes this ticket forbids. The staleness
   * is bounded (only completed runs beyond the cap, only until reload) and read-only,
   * so we accept it rather than fix it. Pinned by live-fold.test.ts
   * ("a genuine removal after eviction is not broadcast for the evicted run").
   */
  private evictSessionOverflow(state: InstanceState, protectedId?: string): void {
    const cap = state.maxRunsPerInstance;
    while (state.sessions.size > cap) {
      let oldestId: string | undefined;
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const [id, session] of state.sessions) {
        // Never evict a still-running run, nor the run just written by the caller
        // (evicting the id the caller is about to upsert would drop it from memory
        // entirely while an upsert for it is in flight).
        if (session.status === "running" || id === protectedId) {
          continue;
        }
        const ms = startMs(session.startTs);
        if (ms < oldestMs) {
          oldestMs = ms;
          oldestId = id;
        }
      }
      if (oldestId === undefined) {
        // Every remaining session is running or protected — nothing safe to evict.
        break;
      }
      state.sessions.delete(oldestId);
      state.diskRunSignatures.delete(oldestId);
      state.detailLoaded.delete(oldestId);
      state.artifactFinished.delete(oldestId);
      state.liveFinished.delete(oldestId);
      state.suppressedMemoryLiveRuns.delete(oldestId);
    }
  }

  private watchArtifacts(state: InstanceState): void {
    const artifactDir = state.discovered.instance.artifactDir;
    let watcher: FSWatcher;
    try {
      watcher = watch(artifactDir, (_eventType, filename) => {
        if (filename === null) {
          return;
        }
        const name = typeof filename === "string" ? filename : String(filename);
        if (name === MEMORY_ARTIFACT_NAMESPACE && this.includeMemory) {
          this.watchMemoryArtifacts(state);
          return;
        }
        if (!name.endsWith(SUMMARY_SUFFIX)) {
          return;
        }
        if (name.length > SUMMARY_SUFFIX.length) {
          this.scheduleArtifactReread(state, name);
        }
      });
    } catch (error) {
      this.logger?.warn?.("Failed to watch artifact dir.", { artifactDir, error: errorMessage(error) });
      return;
    }
    watcher.on("error", (error) => {
      this.logger?.warn?.("Artifact watcher error.", { artifactDir, error: errorMessage(error) });
    });
    state.artifactWatcher = watcher;
    if (this.includeMemory) {
      this.watchMemoryArtifacts(state);
    }
  }

  private watchMemoryArtifacts(state: InstanceState): void {
    if (state.memoryArtifactWatcher !== undefined) {
      return;
    }
    const artifactDir = join(state.discovered.instance.artifactDir, MEMORY_ARTIFACT_NAMESPACE);
    let watcher: FSWatcher;
    try {
      watcher = watch(artifactDir, (_eventType, filename) => {
        if (filename === null) {
          return;
        }
        const name = typeof filename === "string" ? filename : String(filename);
        if (name.endsWith(SUMMARY_SUFFIX) && name.length > SUMMARY_SUFFIX.length) {
          this.scheduleArtifactReread(state, `${MEMORY_ARTIFACT_NAMESPACE}/${name}`);
        }
      });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      this.logger?.warn?.("Failed to watch memory artifact dir.", { artifactDir, error: errorMessage(error) });
      return;
    }
    watcher.on("error", (error) => {
      this.logger?.warn?.("Memory artifact watcher error.", { artifactDir, error: errorMessage(error) });
    });
    state.memoryArtifactWatcher = watcher;
  }

  private scheduleArtifactReread(state: InstanceState, summaryFileName: string): void {
    const existing = state.artifactTimers.get(summaryFileName);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      state.artifactTimers.delete(summaryFileName);
      void this.rereadArtifactSummaryFile(state, summaryFileName);
    }, this.artifactDebounceMs);
    timer.unref?.();
    state.artifactTimers.set(summaryFileName, timer);
  }

  private async rereadArtifactSummaryFile(state: InstanceState, summaryFileName: string): Promise<void> {
    if (!this.isCurrentState(state)) {
      return;
    }
    let entry: SourceStampedSessionSummary | undefined;
    try {
      entry = await readInstanceSessionSummaryByFileName(state.discovered, summaryFileName, {
        maxRuns: state.maxRunsPerInstance,
        includeMemory: this.includeMemory,
        nowMs: this.now(),
      });
    } catch (error) {
      this.logger?.warn?.("Failed to re-read changed run artifact.", { summaryFileName, error: errorMessage(error) });
      return;
    }
    if (entry === undefined || !this.isCurrentState(state)) {
      return;
    }
    const runId = entry.session.id;
    if (entry.signature.status === "running" && state.liveFinished.has(runId)) {
      // A debounced artifact watch can read the start-time "running" summary after
      // live SSE already delivered the terminal frame. Keep the terminal live fold
      // until the disk artifact itself becomes terminal.
      return;
    }
    this.insertDiskSummarySession(state, entry, { emit: true });
  }

  private setupRegistryWatchers(): void {
    for (const dir of this.registryDirs) {
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, () => this.scheduleReconcile());
      } catch (error) {
        this.logger?.warn?.("Failed to watch registry dir.", { dir, error: errorMessage(error) });
        continue;
      }
      watcher.on("error", (error) => {
        this.logger?.warn?.("Registry watcher error.", { dir, error: errorMessage(error) });
      });
      this.registryWatchers.push(watcher);
    }
  }

  private scheduleReconcile(): void {
    if (this.stopped || this.reconcileDebounceTimer !== undefined) {
      return;
    }
    this.reconcileDebounceTimer = setTimeout(() => {
      this.reconcileDebounceTimer = undefined;
      void this.reconcile();
    }, this.registryDebounceMs);
    this.reconcileDebounceTimer.unref?.();
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) {
      return;
    }
    for (const state of this.states.values()) {
      this.refreshStaleRunningSessionsForState(state, { emit: true });
    }
    const generation = this.lifecycleGeneration;
    let discovered: readonly DiscoveredWebInstance[];
    try {
      discovered = await this.discover();
    } catch (error) {
      this.logger?.warn?.("Registry reconcile failed.", { error: errorMessage(error) });
      return;
    }
    if (!this.isActive(generation)) {
      return;
    }
    const byId = new Map(discovered.map((instance) => [instance.instance.sourceId, instance]));
    let changed = false;

    for (const [sourceId, state] of [...this.states]) {
      if (!byId.has(sourceId)) {
        this.removeInstance(state);
        this.states.delete(sourceId);
        changed = true;
      }
    }
    for (const instance of discovered) {
      const existing = this.states.get(instance.instance.sourceId);
      if (existing === undefined) {
        await this.addInstance(instance, { emitSessions: true }, generation);
        changed = true;
      } else {
        if (await this.updateInstance(existing, instance, generation)) {
          changed = true;
        }
        if (this.isCurrentState(existing, generation)) {
          if (existing.artifactWatcher === undefined) {
            try {
              if (await this.refreshDiskState(existing, { emitSessions: true })) {
                changed = true;
              }
              this.watchArtifacts(existing);
            } catch (error) {
              this.logger?.warn?.("Failed to refresh instance history.", {
                sourceId: existing.discovered.instance.sourceId,
                error: errorMessage(error),
              });
            }
          } else if (this.includeMemory && existing.memoryArtifactWatcher === undefined) {
            this.watchMemoryArtifacts(existing);
          }
        }
      }
    }
    if (changed) {
      this.scheduleInstancesEmit();
    }
  }

  private async updateInstance(
    state: InstanceState,
    discovered: DiscoveredWebInstance,
    generation = this.lifecycleGeneration,
  ): Promise<boolean> {
    const previous = state.discovered;
    state.discovered = discovered;
    let changed =
      previous.instance.health !== discovered.instance.health ||
      previous.instance.label !== discovered.instance.label ||
      previous.instance.cwd !== discovered.instance.cwd ||
      previous.instance.timeZone !== discovered.instance.timeZone ||
      previous.instance.timezone !== discovered.instance.timezone;
    let liveReconnected = false;

    if (previous.instance.artifactDir !== discovered.instance.artifactDir) {
      this.disconnectLive(state);
      liveReconnected = true;
      if (state.artifactWatcher !== undefined) {
        state.artifactWatcher.close();
        state.artifactWatcher = undefined;
      }
      if (state.memoryArtifactWatcher !== undefined) {
        state.memoryArtifactWatcher.close();
        state.memoryArtifactWatcher = undefined;
      }
      for (const timer of state.artifactTimers.values()) {
        clearTimeout(timer);
      }
      state.artifactTimers.clear();
      const removedRunIds = [...state.sessions.keys()];
      state.sessions.clear();
      state.diskRunSignatures.clear();
      state.detailLoaded.clear();
      state.artifactFinished.clear();
      state.liveFinished.clear();
      state.suppressedMemoryLiveRuns.clear();
      for (const runId of removedRunIds) {
        this.emit({ t: "session_removed", sourceId: discovered.instance.sourceId, runId });
      }
      await this.seedHistory(state, { emitSessions: true });
      if (!this.isCurrentState(state, generation)) {
        return changed;
      }
      this.watchArtifacts(state);
      await this.connectLive(state, generation);
      changed = true;
    }
    if (!liveReconnected && previous.liveBaseUrl !== discovered.liveBaseUrl) {
      this.disconnectLive(state);
      await this.connectLive(state, generation);
      changed = true;
    }
    return changed;
  }

  private removeInstance(state: InstanceState): void {
    const sourceId = state.discovered.instance.sourceId;
    for (const runId of state.sessions.keys()) {
      this.emit({ t: "session_removed", sourceId, runId });
    }
    this.teardownState(state);
  }

  /** Close connections/watchers/timers for an instance without emitting any frames. */
  private teardownState(state: InstanceState): void {
    this.disconnectLive(state);
    if (state.artifactWatcher !== undefined) {
      state.artifactWatcher.close();
      state.artifactWatcher = undefined;
    }
    if (state.memoryArtifactWatcher !== undefined) {
      state.memoryArtifactWatcher.close();
      state.memoryArtifactWatcher = undefined;
    }
    for (const timer of state.artifactTimers.values()) {
      clearTimeout(timer);
    }
    state.artifactTimers.clear();
    state.diskRunSignatures.clear();
    state.detailLoaded.clear();
    state.artifactFinished.clear();
    state.liveFinished.clear();
    state.suppressedMemoryLiveRuns.clear();
    state.sessions.clear();
  }

  private scheduleInstancesEmit(): void {
    if (this.stopped || this.instancesEmitTimer !== undefined) {
      return;
    }
    this.instancesEmitTimer = setTimeout(() => {
      this.instancesEmitTimer = undefined;
      this.emit({ t: "instances", instances: this.getInstances() });
    }, this.instancesDebounceMs);
    this.instancesEmitTimer.unref?.();
  }

  private emit(frame: BrowserStreamFrame): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(frame);
      } catch (error) {
        this.logger?.warn?.("Browser stream subscriber threw.", { error: errorMessage(error) });
      }
    }
  }

  private projectInstance(state: InstanceState): WebInstance {
    const base = state.discovered.instance;
    return {
      sourceId: base.sourceId,
      label: base.label,
      cwd: base.cwd,
      artifactDir: base.artifactDir,
      health: base.health,
      ...(base.timeZone === undefined ? {} : { timeZone: base.timeZone }),
      ...(base.timezone === undefined ? {} : { timezone: base.timezone }),
      liveConnected: state.liveConnected,
      counts: { runs: state.sessions.size },
    };
  }

  private async seedHistory(state: InstanceState, options: { readonly emitSessions: boolean }): Promise<void> {
    await this.refreshDiskState(state, options);
  }

  private async refreshDiskState(state: InstanceState, options: { readonly emitSessions: boolean }): Promise<boolean> {
    const sessions = await listInstanceSessionSummaries(state.discovered, {
      maxRuns: state.maxRunsPerInstance,
      includeMemory: this.includeMemory,
      nowMs: this.now(),
    });
    let changed = false;
    for (const entry of sessions) {
      if (entry.signature.status === "running" && state.liveFinished.has(entry.session.id)) {
        continue;
      }
      const existing = state.sessions.get(entry.session.id);
      const previousSignature = state.diskRunSignatures.get(entry.session.id);
      if (existing !== undefined && diskRunSignatureEquals(previousSignature, entry.signature)) {
        continue;
      }
      this.insertDiskSummarySession(state, entry, { emit: options.emitSessions });
      changed = true;
    }
    return changed;
  }

  private isActive(generation = this.lifecycleGeneration): boolean {
    return !this.stopped && generation === this.lifecycleGeneration;
  }

  private filteredStates(filter: string): InstanceState[] {
    if (filter === "all") {
      return [...this.states.values()];
    }
    const state = this.states.get(filter);
    return state === undefined ? [] : [state];
  }

  private refreshStaleRunningSessions(filter: string, options: { readonly emit: boolean }): void {
    for (const state of this.filteredStates(filter)) {
      this.refreshStaleRunningSessionsForState(state, options);
    }
  }

  private refreshStaleRunningSessionsForState(state: InstanceState, options: { readonly emit: boolean }): boolean {
    let changed = false;
    for (const [runId, session] of state.sessions) {
      const projected = projectStaleRunningSession(session, this.now());
      if (projected.status === session.status) {
        continue;
      }
      state.sessions.set(runId, projected);
      changed = true;
      if (options.emit) {
        this.emit({ t: "session_upsert", session: toBrowserListSession(projected) });
      }
    }
    if (changed) {
      this.evictSessionOverflow(state);
      this.scheduleInstancesEmit();
    }
    return changed;
  }

  private async countPagedSessions(states: readonly InstanceState[], maxRuns: number): Promise<number> {
    const pages = await Promise.all(
      states.map((state) =>
        listInstanceSessionSummaryPage(state.discovered, {
          maxRuns,
          includeMemory: this.includeMemory,
          nowMs: this.now(),
        }),
      ),
    );
    return pages.reduce((sum, page) => sum + page.total, 0);
  }

  private now(): number {
    return this.clock();
  }

  private isCurrentState(state: InstanceState, generation = this.lifecycleGeneration): boolean {
    return this.isActive(generation) && this.states.get(state.discovered.instance.sourceId) === state;
  }

  private mapOptions(state: InstanceState): { instanceLabel: string; cwd?: string } {
    const cwd = state.discovered.instance.cwd;
    return {
      instanceLabel: state.discovered.instance.label,
      ...(cwd.length === 0 ? {} : { cwd }),
    };
  }

  private shouldDropMemoryLiveFrame(state: InstanceState, frame: RunEventFrame): boolean {
    return state.suppressedMemoryLiveRuns.has(frame.runId) || liveFrameIsMemory(frame);
  }

  private suppressMemoryLiveRun(state: InstanceState, runId: string): void {
    state.suppressedMemoryLiveRuns.add(runId);
    state.live?.runs.delete(runId);
    const pending = state.live?.recomputeTimers.get(runId);
    if (pending !== undefined) {
      clearTimeout(pending);
      state.live?.recomputeTimers.delete(runId);
    }
    const hadSession = state.sessions.delete(runId);
    state.diskRunSignatures.delete(runId);
    state.detailLoaded.delete(runId);
    state.artifactFinished.delete(runId);
    state.liveFinished.delete(runId);
    if (hadSession) {
      this.emit({ t: "session_removed", sourceId: state.discovered.instance.sourceId, runId });
      this.scheduleInstancesEmit();
    }
  }
}

class BoundedStringFifoSet {
  private readonly values = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.values.size;
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    if (this.values.has(value)) {
      return;
    }
    this.values.add(value);
    this.order.push(value);
    while (this.values.size > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.values.delete(oldest);
      }
    }
  }

  delete(value: string): void {
    if (!this.values.delete(value)) {
      return;
    }
    const index = this.order.indexOf(value);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
  }

  clear(): void {
    this.values.clear();
    this.order.length = 0;
  }
}

function runningSummaryFromStart(frame: Extract<RunEventFrame, { t: "run_started" }>): RunSummary {
  return {
    runId: frame.runId,
    conversationId: frame.conversationId,
    status: "running",
    startedAt: frame.startedAt,
    durationMs: 0,
    eventCount: 0,
    artifactPaths: [],
    ...(frame.source === undefined ? {} : { source: frame.source }),
    ...(frame.sourceDetail === undefined ? {} : { sourceDetail: frame.sourceDetail }),
  };
}

function liveFrameIsMemory(frame: RunEventFrame): boolean {
  if (runIdLooksMemory(frame.runId)) {
    return true;
  }
  if (frame.t === "run_started") {
    return frame.source === "memory" || conversationIdLooksMemory(frame.conversationId);
  }
  if (frame.t === "run_finished") {
    return summaryPayloadLooksMemory(frame.summary);
  }
  return eventPayloadLooksMemory(frame.event);
}

function summaryPayloadLooksMemory(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.source === "memory" ||
    (typeof value.conversationId === "string" && conversationIdLooksMemory(value.conversationId)) ||
    (typeof value.runId === "string" && runIdLooksMemory(value.runId));
}

function eventPayloadLooksMemory(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.source === "memory" ||
    (typeof value.conversationId === "string" && conversationIdLooksMemory(value.conversationId)) ||
    (typeof value.runId === "string" && runIdLooksMemory(value.runId));
}

function conversationIdLooksMemory(conversationId: string): boolean {
  return conversationId.startsWith("memory:");
}

function runIdLooksMemory(runId: string): boolean {
  return runId.startsWith("mem-");
}

function runningSummaryFromEvent(frame: Extract<RunEventFrame, { t: "event" }>): RunSummary {
  // Default `startedAt` to the event's own timestamp (else wall clock now) so a live
  // run whose first observed frame is an `event` (run_started missed/dropped) still
  // sorts to the TOP of the newest-first list rather than the bottom (empty startTs).
  const startedAt = eventStartedAt(frame.event) ?? new Date().toISOString();
  return {
    runId: frame.runId,
    conversationId: "",
    status: "running",
    startedAt,
    durationMs: 0,
    eventCount: 0,
    artifactPaths: [],
  };
}

/**
 * Merge a later authoritative summary with an earlier live-derived one, filling only
 * the identity/provenance fields the later summary left as placeholders
 * (`conversationId:""`, or absent `startedAt`/`source`/`sourceDetail`). Lets a sparse
 * `run_finished.summary` inherit provenance a live placeholder already learned rather
 * than regressing it to blanks.
 */
function backfillRunningSummary(base: RunSummary, from: RunSummary): RunSummary {
  const conversationId = base.conversationId.length > 0 ? base.conversationId : from.conversationId;
  const startedAt = base.startedAt ?? from.startedAt;
  const source = base.source ?? from.source;
  const sourceDetail = base.sourceDetail ?? from.sourceDetail;
  const providerSessionId = base.providerSessionId !== undefined ? base.providerSessionId : from.providerSessionId;
  const isolated = base.isolated !== undefined ? base.isolated : from.isolated;
  return {
    ...base,
    conversationId,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(source === undefined ? {} : { source }),
    ...(sourceDetail === undefined ? {} : { sourceDetail }),
    ...(providerSessionId === undefined ? {} : { providerSessionId }),
    ...(isolated === undefined ? {} : { isolated }),
  };
}

/**
 * Best-effort ISO timestamp off a raw runtime event (`timestamp`/`createdAt`/`time`,
 * an ISO string or an epoch number), mirroring observability's `eventTimestamp`.
 * Returns `undefined` when the event carries none.
 */
function eventStartedAt(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const raw = event.timestamp ?? event.createdAt ?? event.time;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function finishedSummary(runId: string, status: string): RunSummary {
  return {
    runId,
    conversationId: "",
    status: normalizeStatus(status),
    durationMs: 0,
    eventCount: 0,
    artifactPaths: [],
  };
}

function normalizeStatus(status: string): RunSummaryStatus {
  return RUN_SUMMARY_STATUSES.has(status as RunSummaryStatus) ? (status as RunSummaryStatus) : "failed";
}

function isTerminalSessionStatus(status: string): boolean {
  return status !== "running" && status !== "stalled";
}

/** Accept a live `run_finished.summary` payload only when it is a plausible {@link RunSummary}. */
function coerceRunSummary(value: unknown): RunSummary | undefined {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return undefined;
  }
  const status = typeof value.status === "string" ? normalizeStatus(value.status) : "succeeded";
  const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : 0;
  const eventCount = typeof value.eventCount === "number" && Number.isFinite(value.eventCount) ? value.eventCount : 0;
  const artifactPaths = Array.isArray(value.artifactPaths)
    ? value.artifactPaths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...(value as Record<string, unknown>),
    runId: value.runId,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : "",
    status,
    durationMs,
    eventCount,
    artifactPaths,
  } as RunSummary;
}

function coerceRuntimeEvent(value: unknown): RuntimeEventLike {
  return isRecord(value) ? (value as RuntimeEventLike) : { type: "unknown" };
}

function mergeSessionPreservingVisibleDetail(
  existing: SourceStampedSession,
  incoming: SourceStampedSession,
): SourceStampedSession {
  const preserveTimeline =
    existing.steps.length > 0 &&
    (incoming.steps.length < existing.steps.length || incoming.totals.steps < existing.totals.steps);
  const preserveFinalText = existing.finalText.trim().length > 0 && incoming.finalText.trim().length === 0;
  // A stripped list/summary upsert carries no ctx/sysPrompt (they live only on the
  // lazy detail read). When the loaded detail already holds them, keep them rather
  // than let `...incoming` erase them.
  const preserveCtx = existing.ctx !== undefined && incoming.ctx === undefined;
  const preserveSysPrompt = existing.sysPrompt !== undefined && incoming.sysPrompt === undefined;
  if (!preserveTimeline && !preserveFinalText && !preserveCtx && !preserveSysPrompt) {
    return incoming;
  }

  return {
    ...incoming,
    ...(preserveTimeline
      ? {
          steps: existing.steps,
          toolCounts: existing.toolCounts,
          totals: {
            ...incoming.totals,
            asst: Math.max(incoming.totals.asst, existing.totals.asst),
            tcalls: Math.max(incoming.totals.tcalls, existing.totals.tcalls),
            think: Math.max(incoming.totals.think, existing.totals.think),
            steps: Math.max(incoming.totals.steps, existing.totals.steps),
          },
        }
      : {}),
    ...(preserveFinalText
      ? {
          finalText: existing.finalText,
          outcome: existing.outcome,
          ...(existing.finalTr === undefined ? {} : { finalTr: existing.finalTr }),
        }
      : {}),
    ...(preserveCtx ? { ctx: existing.ctx } : {}),
    ...(preserveSysPrompt
      ? {
          sysPrompt: existing.sysPrompt,
          ...(existing.sysPromptTr === undefined ? {} : { sysPromptTr: existing.sysPromptTr }),
        }
      : {}),
  };
}

function toBrowserListSession(session: SourceStampedSession): SourceStampedSession {
  const {
    instrTr: _instrTr,
    recalled: _recalled,
    finalTr: _finalTr,
    // Per-turn context + compiled system prompt are detail-only; keep list rows light.
    ctx: _ctx,
    sysPrompt: _sysPrompt,
    sysPromptTr: _sysPromptTr,
    ...withoutDetailText
  } = session;
  return {
    ...withoutDetailText,
    instr: "",
    hasRecall: false,
    finalText: "",
    toolCounts: {},
    totals: {
      ...session.totals,
      asst: 0,
      tcalls: 0,
      think: 0,
    },
    steps: [],
  };
}

function sessionHasVisibleDetail(session: SourceStampedSession): boolean {
  return (
    session.steps.length > 0 ||
    session.finalText.trim().length > 0 ||
    Object.keys(session.toolCounts).length > 0
  );
}

function diskRunSignatureEquals(
  left: DiskRunSignature | undefined,
  right: DiskRunSignature,
): boolean {
  return (
    left !== undefined &&
    left.summaryFileName === right.summaryFileName &&
    left.summaryMtimeMs === right.summaryMtimeMs &&
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.eventCount === right.eventCount
  );
}

function liveEventKey(frame: Extract<RunEventFrame, { t: "event" }>): string | undefined {
  if (typeof frame.eventIndex === "number" && Number.isFinite(frame.eventIndex)) {
    return `event:${frame.eventIndex}`;
  }
  if (typeof frame.seq === "number" && Number.isFinite(frame.seq)) {
    return `seq:${frame.seq}`;
  }
  return undefined;
}

function startMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
