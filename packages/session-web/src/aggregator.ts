/**
 * The session store + orchestrator behind the web operator surface. It folds two
 * sources into one per-instance session model, keyed by `sourceId + runId` at
 * the browser boundary and by `runId` inside each instance state (the finished
 * on-disk artifact is authoritative):
 *
 *  - **Recorded history**: seeded from each instance's artifact dir on discovery,
 *    then refreshed by watching that dir for changed `*.summary.json` files.
 *  - **Live sub-runs**: streamed from each running instance's `live-adapter` SSE
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

import type { RunEventFrame } from "@mono-agent/agent-contracts";
import { mapRunToSession } from "@mono-agent/observability";
import type { RunSummary, RunSummaryStatus, RuntimeEventLike } from "@mono-agent/observability";

import { discoverWebInstances, resolveLiveApiKey } from "./discovery.js";
import type { DiscoveredWebInstance } from "./discovery.js";
import { listInstanceSessions, readInstanceSession } from "./history.js";
import type { SourceStampedSession } from "./history.js";
import { connectLiveStream } from "./live-client.js";
import type { LiveStreamConnection, LiveStreamStatus } from "./live-client.js";
import type { BrowserStreamFrame, WebInstance } from "./session-model.js";

/** On-disk recorded-run summary suffix (observability's `SUMMARY_SUFFIX`, not exported). */
const SUMMARY_SUFFIX = ".summary.json";

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
  readonly artifactTimers: Map<string, ReturnType<typeof setTimeout>>;
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
    const states =
      filter === "all"
        ? [...this.states.values()]
        : ((): InstanceState[] => {
            const state = this.states.get(filter);
            return state === undefined ? [] : [state];
          })();
    return states
      .flatMap((state) => [...state.sessions.values()])
      .sort((left, right) => startMs(right.startTs) - startMs(left.startTs));
  }

  /** One session, reading it from disk on demand when it isn't already held. */
  async getSession(sourceId: string, runId: string): Promise<SourceStampedSession | undefined> {
    const state = this.states.get(sourceId);
    if (state === undefined) {
      return undefined;
    }
    const existing = state.sessions.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    let session: SourceStampedSession | undefined;
    try {
      session = await readInstanceSession(state.discovered, runId);
    } catch (error) {
      this.logger?.warn?.("Failed to read session on demand.", { sourceId, runId, error: errorMessage(error) });
      return undefined;
    }
    if (session !== undefined && this.isCurrentState(state)) {
      this.insertDiskSession(state, runId, session, { emit: true });
    }
    return session;
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
      artifactTimers: new Map(),
      maxRunsPerInstance: this.maxRunsPerInstance,
      artifactFinished: new Set(),
      liveFinished: new Set(),
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
    options: { readonly emit: boolean },
  ): void {
    if (session.status !== "running") {
      state.artifactFinished.add(runId);
    }
    this.insertSession(state, runId, session, options);
  }

  private insertSession(
    state: InstanceState,
    runId: string,
    session: SourceStampedSession,
    options: { readonly emit: boolean },
  ): void {
    state.sessions.set(runId, session);
    this.evictSessionOverflow(state, runId);
    if (options.emit) {
      this.emit({ t: "session_upsert", session });
    }
    this.scheduleInstancesEmit();
  }

  /**
   * Bound `state.sessions` to the per-instance cap, evicting the oldest *completed*
   * sessions by `startTs`. A still-running session is never evicted (its live fold
   * is in flight); each drop emits a `session_removed` so browser subscribers stay
   * in sync with the server-side map.
   */
  private evictSessionOverflow(state: InstanceState, protectedId?: string): void {
    const cap = state.maxRunsPerInstance;
    while (state.sessions.size > cap) {
      let oldestId: string | undefined;
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const [id, session] of state.sessions) {
        // Never evict a still-running run, nor the run just written by the caller
        // (evicting-then-upserting the same id would emit removed→upsert and
        // diverge the browser from the server map).
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
      state.artifactFinished.delete(oldestId);
      state.liveFinished.delete(oldestId);
      this.emit({ t: "session_removed", sourceId: state.discovered.instance.sourceId, runId: oldestId });
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
        if (!name.endsWith(SUMMARY_SUFFIX)) {
          return;
        }
        const runId = name.slice(0, name.length - SUMMARY_SUFFIX.length);
        if (runId.length > 0) {
          this.scheduleArtifactReread(state, runId);
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
  }

  private scheduleArtifactReread(state: InstanceState, runId: string): void {
    const existing = state.artifactTimers.get(runId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      state.artifactTimers.delete(runId);
      void this.rereadArtifactRun(state, runId);
    }, this.artifactDebounceMs);
    timer.unref?.();
    state.artifactTimers.set(runId, timer);
  }

  private async rereadArtifactRun(state: InstanceState, runId: string): Promise<void> {
    if (!this.isCurrentState(state)) {
      return;
    }
    let session: SourceStampedSession | undefined;
    try {
      session = await readInstanceSession(state.discovered, runId);
    } catch (error) {
      this.logger?.warn?.("Failed to re-read changed run artifact.", { runId, error: errorMessage(error) });
      return;
    }
    if (session === undefined || !this.isCurrentState(state)) {
      return;
    }
    if (session.status === "running" && state.liveFinished.has(runId)) {
      // A debounced artifact watch can read the start-time "running" summary after
      // live SSE already delivered the terminal frame. Keep the terminal live fold
      // until the disk artifact itself becomes terminal.
      return;
    }
    this.insertDiskSession(state, runId, session, { emit: true });
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
          try {
            if (await this.refreshDiskState(existing, { emitSessions: true })) {
              changed = true;
            }
            if (existing.artifactWatcher === undefined) {
              this.watchArtifacts(existing);
            }
          } catch (error) {
            this.logger?.warn?.("Failed to refresh instance history.", {
              sourceId: existing.discovered.instance.sourceId,
              error: errorMessage(error),
            });
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
      previous.instance.cwd !== discovered.instance.cwd;
    let liveReconnected = false;

    if (previous.instance.artifactDir !== discovered.instance.artifactDir) {
      this.disconnectLive(state);
      liveReconnected = true;
      if (state.artifactWatcher !== undefined) {
        state.artifactWatcher.close();
        state.artifactWatcher = undefined;
      }
      for (const timer of state.artifactTimers.values()) {
        clearTimeout(timer);
      }
      state.artifactTimers.clear();
      const removedRunIds = [...state.sessions.keys()];
      state.sessions.clear();
      state.artifactFinished.clear();
      state.liveFinished.clear();
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
    for (const timer of state.artifactTimers.values()) {
      clearTimeout(timer);
    }
    state.artifactTimers.clear();
    state.artifactFinished.clear();
    state.liveFinished.clear();
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
      liveConnected: state.liveConnected,
      counts: { runs: state.sessions.size },
    };
  }

  private async seedHistory(state: InstanceState, options: { readonly emitSessions: boolean }): Promise<void> {
    await this.refreshDiskState(state, options);
  }

  private async refreshDiskState(state: InstanceState, options: { readonly emitSessions: boolean }): Promise<boolean> {
    const sessions = await listInstanceSessions(state.discovered, { maxRuns: state.maxRunsPerInstance });
    let changed = false;
    for (const session of sessions) {
      if (session.status === "running" && state.liveFinished.has(session.id)) {
        continue;
      }
      const existing = state.sessions.get(session.id);
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(session)) {
        continue;
      }
      this.insertDiskSession(state, session.id, session, { emit: options.emitSessions });
      changed = true;
    }
    return changed;
  }

  private isActive(generation = this.lifecycleGeneration): boolean {
    return !this.stopped && generation === this.lifecycleGeneration;
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
  return {
    ...base,
    conversationId,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(source === undefined ? {} : { source }),
    ...(sourceDetail === undefined ? {} : { sourceDetail }),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
