import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnResult,
  MemoryLoadOptions,
  MemoryStore,
} from "@mono-agent/agent-contracts";
import {
  AUTO_RECALL_BACKEND_HITS,
  AUTO_RECALL_MAX_BYTES,
  formatPossiblyRelevantBlock,
  POSSIBLY_RELEVANT_HEADING,
  POSSIBLY_RELEVANT_MAX_BYTES,
  selectPossiblyRelevantRecallHits,
  semanticRecallAuthorities,
  type JournalBrowseInput,
  type JournalBrowseSnapshot,
} from "@mono-agent/memory/bujo";

import { redactJsonValue } from "@mono-agent/observability";

import { formatMemoryBackground, formatMemoryProfile, type LabelRecallStore } from "./memory-guidance.js";
import { isHostProcessJobWakeRecall } from "./process-jobs-context.js";
import { readLabelSections, type LabelContext, type LabelSectionRequest } from "./memory-label-sections.js";
import {
  createMemoryRecallServer,
  MEMORY_RECALL_MCP_SERVER_NAME,
  type MemoryRecallOutcome,
  type MemoryRecallRuntimeExtension,
  type RecallCapableStore,
} from "./memory-recall.js";

export interface SharedRecallStore extends MemoryStore, RecallCapableStore, LabelRecallStore {
  /** Local-tier chronology. External recall backends intentionally omit it. */
  tier?(): "lite" | "journal" | "bujo";
  browseJournal?(input: JournalBrowseInput): Promise<JournalBrowseSnapshot>;
  /** Affirmative capability signal; a method alone is insufficient. */
  supportsJournalBrowse?(): boolean;
  /** Optional local-store telemetry hook; it must not alter relevance. */
  recordAccess?(ids: readonly string[]): void;
  /**
   * Deterministic durable write for an explicitly remembered fact. Present only
   * on the bujo backend; external backends implement the shared MemoryStore
   * contract without one, so they never advertise the capability below.
   */
  remember?(
    conversationId: string,
    text: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<{
    readonly id: string;
    readonly source: string;
    readonly text: string;
    readonly duplicate: boolean;
  }>;
  /** Affirmative capability signal; false on a read-only store. */
  supportsRemember?(): boolean;
  supportsRememberDetails?(): boolean;
  rememberDetails?(conversationId: string, text: string,
    details: { readonly about?: string; readonly supersedes?: string; readonly abortSignal?: AbortSignal }): Promise<{
      readonly id: string; readonly source: string; readonly text: string;
      readonly duplicate: boolean; readonly supersededId?: string;
    }>;
}

// Short context-free replies cannot reliably select unsolicited cross-conversation lines.
const SHORT_OWNER_QUERY_MAX_CODEPOINTS = 16;

export interface MemoryRetrievalServiceOptions {
  readonly maxBytes?: number;
  readonly source?: string;
  readonly contextWindow?: boolean;
  readonly profileEnabled?: boolean;
  readonly semanticOnly?: boolean;
  readonly intentExpiry?: boolean;
}

export interface SharedMemoryRecallRuntimeExtensionOptions {
  /** Best-effort diagnostic when the loopback tool endpoint cannot start. */
  readonly onUnavailable?: (error: unknown) => void;
  /** Test seam for simulating endpoint startup failures. */
  readonly listen?: (server: Server) => Promise<void>;
}

type OriginalRecallUnavailableReason =
  | "empty"
  | "lookup_failed";

type OriginalRecallSelection =
  | {
      readonly available: true;
      readonly query: string;
    }
  | {
      readonly available: false;
      readonly reason: OriginalRecallUnavailableReason;
    };

interface SearchCache {
  readonly queries: Map<string, Promise<MemoryRecallOutcome>>;
  readonly expansions: Map<string, Promise<MemoryRecallOutcome>>;
}

interface TurnCache {
  search: SearchCache;
  readonly accessedIds: Set<string>;
  automaticQuery?: string;
  hasPrior?: boolean;
  receipt?: { readonly conversationId: string; readonly state: ConversationRecallState;
    readonly profileFingerprint?: string; readonly lines: readonly string[] };
  original?: OriginalRecallSelection;
  context?: MemoryLoadOptions & { readonly conversationId: string };
}

const WINDOW_TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATIONS = 256;
const MAX_SERVED_LINES = 256;
interface ConversationRecallState {
  previous?: { readonly query: string; readonly at: number };
  profileFingerprint?: string;
  readonly served: Set<string>;
  receiptsKnown: boolean;
  saturated: boolean;
}
const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Keep evidence casing, but measure the exact normalized backend query budget. */
function boundedAutomaticQuery(text: string, limit: number): string {
  const points = Array.from(text.normalize("NFKC").trim().replace(/\s+/gu, " ")).slice(0, limit);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Array.from(normalizeQuery(points.slice(0, mid).join(""))).length <= limit) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("");
}

/** Remove empty section headers as well as unchanged visible bullet lines. */
function freshMemoryLines(content: string, exclude: (line: string) => boolean): string {
  return content.split(/(?=^## )/mu).flatMap((block) => {
    const lines = block.split("\n");
    const fresh = new Set(lines.filter((line) => line.startsWith("- ") && !exclude(line)));
    if (fresh.size === 0) return [];
    return [lines.filter((line, index) => {
      if (line.startsWith("- ")) return fresh.has(line);
      if (line.startsWith("## ")) return true;
      if (!line.trim()) return false;
      // A subsection label survives only when its own following bullets survive.
      for (const next of lines.slice(index + 1)) {
        if (next.startsWith("- ")) { if (fresh.has(next)) return true; }
        else if (next.trim()) break;
      }
      return false;
    }).join("\n")];
  }).join("\n\n");
}

interface SharedRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly type?: "task" | "event" | "note";
    readonly status?: "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";
    readonly isInsight?: boolean;
    readonly createdAt?: string;
    readonly validFrom?: string;
    readonly validTo?: string;
    readonly dueAt?: string;
    readonly supersededBy?: string;
  };
}

/**
 * One configured-harness read path for automatic context and MemoryRecall.
 *
 * Each normalized query in a turn asks the configured backend for a bounded
 * superset once. Automatic recall and the MCP tool then slice that same promise,
 * so an identical query performs at most one embedding/search operation. The
 * cache is explicitly released by the harness after the whole logical turn.
 */
export class MemoryRetrievalService implements MemoryStore {
  private readonly maxBytes: number;
  private readonly source: string;
  private readonly turns = new Map<string, TurnCache>();
  private readonly conversations = new Map<string, ConversationRecallState>();
  private readonly contextWindow: boolean;
  private readonly profileEnabled: boolean;
  private readonly semanticOnly: boolean;
  private readonly intentExpiry: boolean;
  readonly persistCompletedTurn?: (turn: MemoryCompletedTurn) => Promise<MemoryCompletedTurnResult>;

  constructor(
    private readonly store: SharedRecallStore,
    options: MemoryRetrievalServiceOptions = {},
  ) {
    this.maxBytes = Math.max(1, Math.min(options.maxBytes ?? AUTO_RECALL_MAX_BYTES, AUTO_RECALL_MAX_BYTES));
    this.source = options.source ?? "memory";
    this.contextWindow = options.contextWindow === true && store.tier?.() === "bujo";
    this.profileEnabled = options.profileEnabled === true && store.tier?.() === "bujo";
    this.semanticOnly = options.semanticOnly === true && store.tier?.() === "bujo";
    this.intentExpiry = options.intentExpiry === true && store.tier?.() === "bujo";
    const persistCompletedTurn = store.persistCompletedTurn;
    if (persistCompletedTurn !== undefined) {
      // Preserve capability detection: stores without the strong method leave
      // this property absent so the harness takes its legacy fallback.
      this.persistCompletedTurn = (turn) => persistCompletedTurn.call(store, turn);
    }
  }

  async load(conversationId: string, query?: string, options: MemoryLoadOptions = {}): Promise<MemoryBlock | undefined> {
    if (!this.contextWindow && !this.profileEnabled && !this.intentExpiry) return await this.loadLegacy(conversationId, query, options);
    const ephemeral = options.turnId === undefined;
    const turnId = options.turnId ?? `uncached:${randomUUID()}`;
    const turn = this.turnCache(turnId);
    const conversationKey = fingerprint(conversationId);
    const isolated = options.isolated === true;
    if (isolated) this.breakQueryAdjacency(conversationId);
    let state = isolated ? undefined : this.conversations.get(conversationKey);
    if (state === undefined) {
      state = { served: new Set(), receiptsKnown: false, saturated: false };
    }
    if (!isolated) {
      this.conversations.delete(conversationKey);
      this.conversations.set(conversationKey, state);
      while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    }
    const owner = options.ownerTurn === true && !isHostProcessJobWakeRecall();
    if (!owner) delete state.previous; // Any verified non-owner/trigger interrupts adjacency.
    const current = this.contextWindow
      ? boundedAutomaticQuery(query ?? "", 1536)
      : normalizeEvidenceQuery(query ?? "");
    const ownerQuery = (options.ownerQuery ?? query ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (turn.automaticQuery === undefined) {
      const at = options.hostInstant === undefined ? Date.now() : Date.parse(options.hostInstant);
      // Lazy expiry also drops stale predecessor text from other bounded entries.
      for (const cached of this.conversations.values()) {
        if (cached.previous !== undefined && Number.isFinite(at)
          && at - cached.previous.at >= WINDOW_TTL_MS) delete cached.previous;
      }
      const previous = state.previous;
      const qualifies = this.contextWindow && owner && ownerQuery.length > 0 && current.length > 0 && previous !== undefined
        && Number.isFinite(at) && at >= previous.at && at - previous.at < WINDOW_TTL_MS;
      // No transcript or assistant/tool content; only the preceding redacted owner query.
      turn.hasPrior = qualifies;
      turn.automaticQuery = qualifies
        ? `${boundedAutomaticQuery(current, 1023)}\n${boundedAutomaticQuery(previous.query, 512)}` : current;
      if (this.contextWindow && owner && ownerQuery && !isolated && Number.isFinite(at)) {
        const redacted = redactJsonValue(ownerQuery, 32_000, { contentPatternRedaction: true });
        state.previous = { query: boundedAutomaticQuery(typeof redacted === "string" ? redacted : "", 512), at };
      } else delete state.previous;
    }
    if (options.retainedContext !== true && !isolated) {
      // A distinct epoch object fences late receipts from an abandoned reseed.
      state = { served: new Set(), receiptsKnown: false, saturated: false,
        ...(state.previous === undefined ? {} : { previous: state.previous }) };
      this.conversations.set(conversationKey, state);
    }
    // Empty/non-owner cold invocations still establish that the cache observed
    // this provider epoch, without claiming any lines were delivered.
    if (options.retainedContext !== true && !isolated) turn.receipt = { conversationId, state, lines: [] };
    const suppress = options.retainedContext === true && (!state.receiptsKnown || state.saturated);
    try {
      let profile: ReturnType<typeof formatMemoryProfile> | undefined;
      if (owner && this.profileEnabled) {
        try {
          profile = formatMemoryProfile(this.store, options.hostLocalDate ?? options.hostDate ?? new Date().toISOString().slice(0, 10), this.maxBytes, options.hostInstant, this.semanticOnly, this.intentExpiry);
        } catch { options.onWarning?.("memory_profile_unavailable"); }
      }
      let recall: MemoryBlock | undefined;
      try {
        recall = await this.loadLegacy(conversationId, query, { ...options, turnId }, turn.automaticQuery, turn.hasPrior, new Set(profile?.entries.map((entry) => entry.id)));
      } catch (error) {
        if (!this.profileEnabled || !owner) throw error;
        options.onWarning?.("memory_recall_unavailable");
      }
      if (!owner || suppress) return undefined;
      const profileChanged = profile !== undefined && profile.fingerprint !== state.profileFingerprint;
      const emptyReplacement = profileChanged && profile!.content.length === 0 && state.profileFingerprint !== undefined
        ? "## Owner profile (current owner-stated background)\n- No active supported profile entries." : "";
      const profileContent = profileChanged ? profile!.content || (Buffer.byteLength(emptyReplacement, "utf8") <= this.maxBytes ? emptyReplacement : "") : undefined;
      // Even a changed profile excludes identical lines from the similarity/background block.
      const profileLines = new Set(profile?.entries.map((entry) => `- ${entry.text}`));
      const recallContent = recall === undefined ? "" : freshMemoryLines(recall.content,
        (line) => profileLines.has(line) || (options.retainedContext === true && state!.served.has(fingerprint(line))));
      let content = [profileContent, recallContent].filter(Boolean).join("\n\n");
      // Whole-entry byte budget; the Unicode profile budget is enforced separately.
      const omittedRecall = Buffer.byteLength(content, "utf8") > this.maxBytes;
      if (omittedRecall) content = profileContent || recallContent;
      if (!isolated) turn.receipt = { conversationId, state, ...(profileChanged ? { profileFingerprint: profile!.fingerprint } : {}),
        lines: content.split("\n").filter((line) => line.startsWith("- ")).map(fingerprint) };
      return content ? { kind: "markdown", source: this.source, content, traceContent: false,
        truncated: omittedRecall || (profile?.truncated ?? false) || (recall?.truncated ?? false) } : undefined;
    } finally { if (ephemeral) this.releaseTurn(turnId); }
  }

  recordInvocation(turnId: string): void {
    const receipt = this.turns.get(turnId)?.receipt;
    if (receipt === undefined || this.conversations.get(fingerprint(receipt.conversationId)) !== receipt.state) return;
    const state = receipt.state;
    state.receiptsKnown = true;
    if (receipt.profileFingerprint !== undefined) state.profileFingerprint = receipt.profileFingerprint;
    for (const line of receipt.lines) {
      if (state.served.size >= MAX_SERVED_LINES && !state.served.has(line)) { state.saturated = true; break; }
      state.served.add(line);
    }
  }

  breakQueryAdjacency(conversationId: string): void {
    const state = this.conversations.get(fingerprint(conversationId));
    if (state !== undefined) delete state.previous;
  }

  resetRecallContext(conversationId?: string): void {
    if (conversationId === undefined) { this.conversations.clear(); this.turns.clear(); }
    else {
      this.conversations.delete(fingerprint(conversationId));
      for (const [id, turn] of this.turns) if (turn.context?.conversationId === conversationId) this.turns.delete(id);
    }
  }

  private async loadLegacy(
    conversationId: string,
    query?: string,
    options: MemoryLoadOptions = {},
    automaticQuery?: string,
    hasPrior = false,
    profileIds: ReadonlySet<string> = new Set(),
  ): Promise<MemoryBlock | undefined> {
    // Host-issued wake identity is bound to the exact responder invocation,
    // not inferred from the query or an untrusted client-supplied JSON field.
    const hostWake = isHostProcessJobWakeRecall();
    const evidenceQuery = normalizeEvidenceQuery(automaticQuery ?? query ?? conversationId);
    const originalQuestion = query === undefined ? "" : normalizeEvidenceQuery(query);
    const ephemeral = options.turnId === undefined;
    const turnId = options.turnId ?? `uncached:${randomUUID()}`;
    if (evidenceQuery.length === 0) {
      if (!ephemeral) this.setOriginalUnavailable(turnId, "empty");
      return undefined;
    }
    try {
      // An uncached non-owner load could only feed automatic context, which
      // non-owner turns never receive; skip the lookup entirely.
      if (ephemeral && options.ownerTurn !== true) return undefined;
      this.turnCache(turnId).context = { ...options, conversationId };
      let outcome: MemoryRecallOutcome;
      if (ephemeral || originalQuestion.length === 0) {
        if (!ephemeral) this.setOriginalUnavailable(turnId, "empty");
        outcome = await this.recallOutcomeForTurn(turnId, evidenceQuery, {
          topK: AUTO_RECALL_BACKEND_HITS,
          trackAccess: false,
        });
      } else {
        const turn = this.turnCache(turnId);
        const selection: OriginalRecallSelection = {
          available: true,
          query: originalQuestion,
        };
        // The latest load owns the selection. Explicit tool calls never replace it.
        turn.original = selection;
        try {
          outcome = await this.recallOutcomeInTurn(turn, evidenceQuery, { topK: AUTO_RECALL_BACKEND_HITS });
        } catch (error) {
          if (evidenceQuery === originalQuestion && this.turns.get(turnId) === turn && turn.original === selection) {
            turn.original = { available: false, reason: "lookup_failed" };
          }
          throw error;
        }
      }
      // Lexical-only results are never injected; keep the degraded warning.
      if (outcome.degradation?.code === "embedding_unavailable") {
        throw new Error("Semantic memory retrieval is unavailable; lexical-only recall found no eligible automatic evidence.");
      }
      // Privacy default: automatic memory reaches only host-verified owner
      // turns. Group chats, other senders and triggers get no block; the
      // lookup above still backs the explicit tool's original-query mode.
      if (options.ownerTurn !== true || hostWake) return undefined;
      // Language-neutral selection relies on embedding scores; a lexical-only
      // store (e.g. Lite) never feeds the automatic block.
      if (outcome.retrievalMode !== "hybrid") return undefined;
      const asOf = [options.hostLocalDate, options.hostDate]
        .find((value) => value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value));
      const now = options.hostInstant !== undefined && Number.isFinite(Date.parse(options.hostInstant))
        ? options.hostInstant : undefined;
      // Preserve exact-name cards and labelled background on short owner turns;
      // suppress only unsolicited similarity-selected lines.
      const shortOwnerQuery = !hasPrior && query !== undefined
        && Array.from(query.normalize("NFC").trim()).length <= SHORT_OWNER_QUERY_MAX_CODEPOINTS;
      let semanticAuthorities: ReadonlyMap<string, number> | undefined;
      if (this.semanticOnly) {
        try {
          semanticAuthorities = semanticRecallAuthorities(
            this.store.labelsForMemories?.(outcome.hits.map((hit) => hit.record.id)) ?? [],
            this.store.labelsForEntity?.bind(this.store), asOf ?? new Date().toISOString().slice(0, 10), now, this.intentExpiry,
          );
        } catch {
          semanticAuthorities = new Map();
          options.onWarning?.("memory_recall_unavailable");
        }
      }
      const hits = shortOwnerQuery ? [] : selectPossiblyRelevantRecallHits(outcome.hits, {
        ...(semanticAuthorities === undefined ? {} : { semanticAuthorities }),
        intentExpiry: this.intentExpiry,
        ...(asOf === undefined ? {} : { asOf }), ...(now === undefined ? {} : { now }),
      }).filter((hit) => !profileIds.has(hit.record.id));
      const budget = Math.min(this.maxBytes, POSSIBLY_RELEVANT_MAX_BYTES);
      const block = hits.length > 0
        ? formatPossiblyRelevantBlock(hits, recallAttributions(this.store, hits), budget, asOf, now) : undefined;
      let background: ReturnType<typeof formatMemoryBackground>;
      try {
        const available = this.maxBytes - (block === undefined ? 0 : Buffer.byteLength(block.content, "utf8") + 2);
        background = formatMemoryBackground(this.store, evidenceQuery, conversationId, options, outcome.hits, available,
          new Set([...profileIds, ...block?.shown.map((hit) => hit.record.id) ?? []]), this.semanticOnly, this.intentExpiry);
      } catch {
        // Corrupt or temporarily unavailable labels must not erase ordinary recall.
        background = undefined;
      }
      if (block === undefined && !background?.content) return undefined;
      if (block !== undefined) this.recordServed(turnId, block.shown);
      return { kind: "markdown", source: this.source,
        ...(this.semanticOnly || this.intentExpiry ? { traceContent: false } : {}),
        content: [block?.content, background?.content].filter((text) => text !== undefined && text.length > 0).join("\n\n"),
        truncated: (block?.truncated ?? false) || (background?.truncated ?? false) };
    } finally {
      if (ephemeral) this.releaseTurn(turnId);
    }
  }

  async recallForTurn(
    turnId: string,
    query: string,
    options: { readonly topK?: number; readonly trackAccess?: boolean; readonly expandHops?: 0 | 1 } = {},
  ): Promise<readonly SharedRecallHit[]> {
    const outcome = await this.recallOutcomeForTurn(turnId, query, {
      ...options,
      // The statusless compatibility surface must decide whether it can serve
      // before recording telemetry. Degraded hits are available only through
      // recallOutcomeForTurn(), whose caller can preserve their status.
      trackAccess: false,
    });
    if (outcome.degradation !== undefined) {
      throw new Error("Memory recall is degraded; use status-bearing recall to inspect lexical-only results.");
    }
    if (options.trackAccess !== false) this.recordServed(turnId, outcome.hits);
    return outcome.hits;
  }

  async recallOutcomeForTurn(
    turnId: string,
    query: string,
    options: { readonly topK?: number; readonly trackAccess?: boolean; readonly expandHops?: 0 | 1 } = {},
  ): Promise<MemoryRecallOutcome> {
    const turn = this.turnCache(turnId);
    const outcome = await this.recallOutcomeInTurn(turn, query, options);
    if (options.trackAccess !== false) this.recordServed(turnId, outcome.hits);
    return outcome;
  }

  async recallOriginalOutcomeForTurn(
    turnId: string,
    options: { readonly topK?: number; readonly expandHops?: 0 | 1 } = {},
  ): Promise<
    | { readonly available: true; readonly query: string; readonly outcome: MemoryRecallOutcome }
    | { readonly available: false; readonly reason: "not_loaded" | OriginalRecallUnavailableReason | "replaced" }
  > {
    const turn = this.turns.get(turnId);
    const selection = turn?.original;
    if (turn === undefined || selection === undefined) {
      return { available: false, reason: "not_loaded" };
    }
    if (!selection.available) return selection;
    try {
      // Re-enter the same turn cache so graph-capable explicit recall can apply
      // its existing one-hop policy without repeating the backend lookup.
      const outcome = await this.recallOutcomeInTurn(turn, selection.query, options);
      if (this.turns.get(turnId) !== turn) {
        return { available: false, reason: "not_loaded" };
      }
      if (turn.original !== selection) {
        return { available: false, reason: "replaced" };
      }
      return { available: true, query: selection.query, outcome };
    } catch (error) {
      if (this.turns.get(turnId) === turn && turn.original === selection) {
        turn.original = { available: false, reason: "lookup_failed" };
      }
      throw error;
    }
  }

  releaseTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  releaseAllTurns(): void {
    this.turns.clear();
  }

  private invalidateRecallQueries(): void {
    if (!this.contextWindow && !this.profileEnabled && !this.intentExpiry) { this.releaseAllTurns(); return; }
    // Writes invalidate search results, not pending or already-prepared delivery
    // receipts. Keep the turn object, but replace its search generation so work
    // already in flight cannot populate the current expansion cache.
    for (const turn of this.turns.values()) {
      turn.search = { queries: new Map(), expansions: new Map() };
      turn.accessedIds.clear();
      delete turn.original;
    }
  }

  intentExpiryEnabled(): boolean { return this.intentExpiry; }
  recencyEnabled(): boolean { return this.store.recencyEnabled?.() === true; }
  rankDeliberateRecall(hits: readonly SharedRecallHit[]): readonly SharedRecallHit[] {
    return this.store.rankDeliberateRecall?.(hits) ?? hits;
  }

  supportsGraphExpansion(): boolean {
    return this.store.expandGraph !== undefined && this.store.supportsGraphExpansion?.() !== false;
  }

  supportsLabelSections(): boolean {
    return this.store.labelsForEntity !== undefined && this.store.guidanceForScope !== undefined;
  }

  labelSectionsForTurn(turnId: string, request: LabelSectionRequest, candidates: readonly SharedRecallHit[] = [], observation?: LabelContext) {
    const context = { ...this.turns.get(turnId)?.context, ...observation };
    return readLabelSections(this.store, request, context, candidates, this.intentExpiry);
  }

  supportsJournalBrowse(): boolean {
    if (
      typeof this.store.tier !== "function"
      || typeof this.store.browseJournal !== "function"
      || this.store.supportsJournalBrowse?.() !== true
    ) return false;
    const tier = this.store.tier();
    return tier === "lite" || tier === "journal" || tier === "bujo";
  }

  tier(): "lite" | "journal" | "bujo" {
    if (!this.supportsJournalBrowse() || this.store.tier === undefined) {
      throw new Error("memory: the configured store has no chronological journal surface.");
    }
    return this.store.tier();
  }

  async browseJournal(input: JournalBrowseInput): Promise<JournalBrowseSnapshot> {
    if (!this.supportsJournalBrowse() || this.store.browseJournal === undefined) {
      throw new Error("memory: the configured store has no chronological journal surface.");
    }
    return await this.store.browseJournal(input);
  }

  recordAccessIdsForTurn(turnId: string, ids: readonly string[]): void {
    if (this.store.recordAccess === undefined) return;
    // A late tool request must not recreate a cache after endpoint/turn cleanup.
    const turn = this.turns.get(turnId);
    if (turn === undefined) return;
    const fresh = ids.filter((id) => {
      if (turn.accessedIds.has(id)) return false;
      turn.accessedIds.add(id);
      return true;
    });
    if (fresh.length > 0) this.store.recordAccess(fresh);
  }

  supportsRemember(): boolean {
    // Both halves, not just the signal: advertising a write surface whose
    // method is absent would fail every call instead of never appearing.
    return typeof this.store.remember === "function" && this.store.supportsRemember?.() === true;
  }

  supportsRememberDetails(): boolean {
    return this.supportsRemember() && typeof this.store.rememberDetails === "function"
      && this.store.supportsRememberDetails?.() === true;
  }

  async rememberDetails(conversationId: string, text: string,
    details: { readonly about?: string; readonly supersedes?: string; readonly abortSignal?: AbortSignal }) {
    if (!this.supportsRememberDetails()) throw new Error("memory: Remember details require writable BuJo memory.");
    try {
      const result = await this.store.rememberDetails!(conversationId, text, details);
      if (!result.duplicate || result.supersededId !== undefined) this.invalidateRecallQueries();
      return result;
    } catch (error) {
      // A published outbox intent can already have invalidated the old note
      // before replay reports a partial projection failure.
      if (typeof error === "object" && error !== null
        && ((error as { rememberIntentWritten?: unknown }).rememberIntentWritten === true
          || (error as { canonicalWritten?: unknown }).canonicalWritten === true)) this.invalidateRecallQueries();
      throw error;
    }
  }

  async remember(
    conversationId: string,
    text: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<{
    readonly id: string;
    readonly source: string;
    readonly text: string;
    readonly duplicate: boolean;
  }> {
    const remember = this.store.remember;
    if (remember === undefined) {
      throw new Error("memory: the configured store has no durable remember surface.");
    }
    const result = await remember.call(this.store, conversationId, text, options);
    // Recall memoizes per turn, so a query answered BEFORE this write would keep
    // returning its stale empty result for the rest of the run — contradicting
    // the immediate-recall guarantee the tool reports. Drop the caches rather
    // than try to predict which queries this fact should now match.
    //
    // An already-stored fact changed nothing durable, so leave the caches
    // alone: clearing them there would make concurrent turns repeat identical
    // backend searches and re-record access telemetry.
    if (!result.duplicate) this.invalidateRecallQueries();
    return result;
  }

  async flush(): Promise<void> {
    await this.store.flush?.();
  }

  private async recallOutcomeInTurn(
    turn: TurnCache,
    query: string,
    options: { readonly topK?: number; readonly expandHops?: 0 | 1 } = {},
  ): Promise<MemoryRecallOutcome> {
    const evidenceQuery = normalizeEvidenceQuery(query);
    const backendQuery = normalizeQuery(evidenceQuery);
    if (backendQuery.length === 0) return { hits: [], retrievalMode: "lexical_only" };
    // Raw backend lookup remains normalized/shared, while graph expansion has
    // its own evidence-preserving key below. Capitalization is a precision
    // signal for query-local entity references and must reach graph policy.
    // Capture this generation before awaiting the lookup. A write can replace
    // turn.search while this call is pending; its late expansion stays here.
    const search = turn.search;
    let lookup = search.queries.get(backendQuery);
    if (lookup === undefined) {
      lookup = this.store.recallWithOutcome === undefined
        ? Promise.resolve(
            this.store.recall(backendQuery, { topK: AUTO_RECALL_BACKEND_HITS, trackAccess: false }),
          ).then((hits) => ({ hits, retrievalMode: "hybrid" as const }))
        : Promise.resolve(
            this.store.recallWithOutcome(backendQuery, {
              topK: AUTO_RECALL_BACKEND_HITS,
              trackAccess: false,
            }),
          );
      search.queries.set(backendQuery, lookup);
    }
    const limit = clampLimit(options.topK, 8);
    const direct = await lookup;
    if (options.expandHops === 1 && this.supportsGraphExpansion() && this.store.expandGraph !== undefined) {
      const expansionKey = `${evidenceQuery}\0${limit}`;
      let expanded = search.expansions.get(expansionKey);
      if (expanded === undefined) {
        expanded = Promise.resolve(this.store.expandGraph(evidenceQuery, direct.hits, { topK: limit }))
          .then((hits) => ({
            hits,
            retrievalMode: direct.retrievalMode,
            ...(direct.degradation === undefined ? {} : { degradation: direct.degradation }),
          }));
        search.expansions.set(expansionKey, expanded);
      }
      return await expanded;
    }
    return {
      hits: direct.hits.slice(0, limit),
      retrievalMode: direct.retrievalMode,
      ...(direct.degradation === undefined ? {} : { degradation: direct.degradation }),
    };
  }

  private setOriginalUnavailable(turnId: string, reason: OriginalRecallUnavailableReason): void {
    this.turnCache(turnId).original = { available: false, reason };
  }

  private turnCache(turnId: string): TurnCache {
    let cache = this.turns.get(turnId);
    if (cache !== undefined) return cache;
    cache = { search: { queries: new Map(), expansions: new Map() }, accessedIds: new Set() };
    this.turns.set(turnId, cache);
    return cache;
  }

  private recordServed(turnId: string, hits: readonly SharedRecallHit[]): void {
    this.recordAccessIdsForTurn(turnId, hits.map((hit) => hit.record.id));
  }
}

/** Create a per-turn loopback MCP endpoint over the shared in-process service. */
export function createSharedMemoryRecallRuntimeExtension(
  service: MemoryRetrievalService,
  options: SharedMemoryRecallRuntimeExtensionOptions = {},
): (input: { readonly runId: string }) => Promise<MemoryRecallRuntimeExtension> {
  return async ({ runId }) => {
    const path = `/mcp/${randomUUID()}`;
    const graphEnabled = service.supportsGraphExpansion();
    const boundStore: RecallCapableStore = {
      intentExpiryEnabled: () => service.intentExpiryEnabled(),
      recencyEnabled: () => service.recencyEnabled(),
      rankDeliberateRecall: (hits) => service.rankDeliberateRecall(hits),
      recall: (query, options) => service.recallForTurn(runId, query, options),
      ...(service.supportsLabelSections() ? {
        labelSections: (request: LabelSectionRequest, candidates: readonly SharedRecallHit[], observation?: LabelContext) => service.labelSectionsForTurn(runId, request, candidates, observation),
      } : {}),
      recallWithOutcome: (query, options) => service.recallOutcomeForTurn(runId, query, options),
      recallOriginalWithOutcome: (originalOptions) => service.recallOriginalOutcomeForTurn(runId, {
        ...(originalOptions?.topK === undefined ? {} : { topK: originalOptions.topK }),
        expandHops: graphEnabled ? 1 : 0,
      }),
      ...(graphEnabled ? {
        supportsGraphExpansion: () => true,
        expandGraph: async (query: string, _directHits: readonly SharedRecallHit[], graphOptions?: { readonly topK?: number }) => (
          await service.recallOutcomeForTurn(runId, query, {
            ...(graphOptions?.topK === undefined ? {} : { topK: graphOptions.topK }),
            trackAccess: false,
            expandHops: 1,
          })
        ).hits,
      } : {}),
      // Non-graph stores need the same served-only accounting. The service
      // deduplicates IDs across automatic and deliberate delivery in this turn.
      recordAccess: (ids: readonly string[]) => service.recordAccessIdsForTurn(runId, ids),
      close: async () => {},
    };
    let port: number | undefined;
    const http = createServer((request, response) => {
      if (request.url !== path || !isLoopbackHost(request.headers.host)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (port === undefined) {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        response.end("Memory recall is starting");
        return;
      }
      const boundPort = port;
      void (async () => {
        const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
        const webRequest = nodeRequestAsWebRequest(request);
        // Stateless server+transport minted per request: the runtime opens a
        // fresh MCP client (with a new `initialize`) against this same per-run
        // endpoint on every model-failover attempt, and a long-lived
        // session-stateful transport rejects that second initialize ("Server
        // already initialized"), silently dropping the tool for the answering
        // attempt. The SDK's stateless mode requires a fresh transport per
        // request, so both are per-request; the bound store stays shared.
        const requestMcp = createMemoryRecallServer(boundStore);
        // No sessionIdGenerator: stateless mode (exact-optional forbids an
        // explicit undefined).
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          allowedHosts: [`127.0.0.1:${boundPort}`],
          enableDnsRebindingProtection: true,
        });
        try {
          // The SDK's Node transport declaration is not exact-optional compatible
          // with its own base Transport under this repo's compiler settings.
          await requestMcp.connect(transport as never);
          const webResponse = await transport.handleRequest(webRequest, { parsedBody });
          if (webResponse === undefined) throw new Error("MemoryRecall MCP transport is unavailable.");
          await writeWebResponse(response, webResponse);
        } finally {
          await requestMcp.close().catch(() => undefined);
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    try {
      await (options.listen ?? listenLoopback)(http);
      const address = http.address() as AddressInfo;
      port = address.port;
      let closed = false;
      return {
        runtimeOptions: {
          mcpServers: {
            [MEMORY_RECALL_MCP_SERVER_NAME]: {
              type: "http",
              url: `http://127.0.0.1:${address.port}${path}`,
            },
          },
        },
        cleanup: async () => {
          if (closed) return;
          closed = true;
          try {
            await closeHttpServer(http);
          } finally {
            // An abort-ignoring provider may keep the outer logical turn alive
            // after this endpoint releases its concurrency permit. No tool can
            // use the cache once the endpoint is closed, so release it here as
            // well as in the harness's eventual outer finally.
            service.releaseTurn(runId);
          }
        },
      };
    } catch (error) {
      await closeHttpServer(http);
      service.releaseTurn(runId);
      try {
        options.onUnavailable?.(error);
      } catch {
        // Diagnostics are best-effort; a logger failure cannot fail the turn.
      }
      // Automatic recall already ran through MemoryRetrievalService.load(). A
      // loopback startup failure therefore omits only the explicit tool and
      // must not prevent the provider turn from proceeding.
      return { runtimeOptions: { mcpServers: {} }, cleanup: async () => { service.releaseTurn(runId); } };
    }
  };
}

export function isSharedRecallStore(store: MemoryStore | undefined): store is SharedRecallStore {
  const value = store as Partial<SharedRecallStore> | undefined;
  return value !== undefined && typeof value.recall === "function" && typeof value.close === "function";
}

export function normalizeMemoryRecallQuery(query: string): string {
  return normalizeQuery(query);
}

function normalizeQuery(query: string): string {
  return normalizeEvidenceQuery(query).toLocaleLowerCase("en-US");
}

function normalizeEvidenceQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, 4_000);
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(AUTO_RECALL_BACKEND_HITS, Math.max(1, Math.trunc(limit)));
}

export { POSSIBLY_RELEVANT_HEADING };

/** Reader-facing attribution when every label on the line agrees. */
function recallAttributions(store: SharedRecallStore, hits: readonly SharedRecallHit[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (store.labelsForMemories === undefined) return out;
  let labels: ReturnType<NonNullable<SharedRecallStore["labelsForMemories"]>>;
  try {
    labels = store.labelsForMemories(hits.map((hit) => hit.record.id));
  } catch {
    // Attribution is decoration; label trouble must not erase recall.
    return out;
  }
  const byMemory = new Map<string, Set<string>>();
  for (const hit of labels) {
    if (hit.label.kind === "lesson") continue;
    const set = byMemory.get(hit.memoryId) ?? new Set<string>();
    set.add(hit.label.attribution);
    byMemory.set(hit.memoryId, set);
  }
  const words: Record<string, string> = { "user-stated": "you said", "assistant-inferred": "assistant noted", document: "from a document" };
  for (const [id, set] of byMemory) {
    const only = set.size === 1 ? words[[...set][0]!] : undefined;
    if (only !== undefined) out.set(id, only);
  }
  return out;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d+$/u.test(host);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("MemoryRecall MCP request exceeds 1 MB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nodeRequestAsWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return new Request(`http://${String(request.headers.host)}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

async function writeWebResponse(response: import("node:http").ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
