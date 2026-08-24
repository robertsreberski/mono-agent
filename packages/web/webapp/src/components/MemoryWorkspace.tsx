import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ApiError, api } from "../api";
import { useConsoleStore } from "../console-store";
import {
  isTerminalMemoryOperation,
  layoutMemoryGraph,
  memoryOperationPollDelay,
  truncateMemoryGraphLabel,
} from "../memory-workspace";
import type {
  MemoryActionInput,
  MemoryAvailability,
  MemoryCapability,
  MemoryConfirmation,
  MemoryGraph,
  MemoryLifecycle,
  MemoryMutationAdmission,
  MemoryOperation,
  MemoryRecord,
  MemoryRecordDetail,
  MemoryRecordQuery,
  MemoryRecordType,
  MemorySemanticPatch,
} from "../types";
import { MobileAgentPicker } from "./AgentRail";
import { Icon } from "./Icon";

type MemoryTab = "overview" | "records" | "graph";
const MEMORY_TABS: readonly MemoryTab[] = ["overview", "records", "graph"];
const MEMORY_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface PendingForget {
  readonly recordId: string;
  readonly input: MemoryActionInput;
  readonly confirmation: MemoryConfirmation;
}

const displayDate = (value: string | undefined): string => {
  if (value === undefined) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};

const dateTimeLocalValue = (value: string | undefined): string => {
  if (value === undefined) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const dateTimeLocalIso = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export const memoryActionKey = (): string => {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return `memory-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/** Never render arbitrary transport/provider text in the owner memory workspace. */
export const memoryWorkspaceError = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "revision_conflict": return "This memory changed. Refresh it before trying again.";
      case "idempotency_conflict": return "This action key was already used for another memory change.";
      case "replay_expired": return "This memory action is too old to replay. Refresh before trying again.";
      case "confirmation_invalid": return "The confirmation expired. Start the forget action again.";
      case "actions_disabled": return "Memory changes are disabled for this agent.";
      case "memory_offline": return "This agent is offline. No memory snapshot is retained in the browser.";
      case "memory_unsupported": return "This agent does not expose a live memory operator.";
      case "agent_not_found": return "This route does not match a discovered agent.";
      case "not_found": return "The requested memory record is no longer available.";
      case "invalid_request": return "The memory request was not accepted. Check the edited fields.";
      case "unavailable": return "The live memory operator is temporarily unavailable.";
      default:
        if (error.status === 409) return "The memory changed. Refresh before trying again.";
        if (error.status === 503) return "The live memory operator is temporarily unavailable.";
    }
  }
  return fallback;
};

const operationError = (operation: MemoryOperation): string => {
  switch (operation.errorCode) {
    case "revision_conflict": return "This memory changed before the action completed.";
    case "not_found": return "The memory record was no longer available.";
    case "invalid_request": return "The action was no longer valid for this memory.";
    default: return "The memory action failed safely.";
  }
};

const abortableDelay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export const pollMemoryOperation = async (
  sourceId: string,
  initial: MemoryOperation,
  signal: AbortSignal,
  onUpdate?: (operation: MemoryOperation) => void,
): Promise<MemoryOperation> => {
  let current = initial;
  const operationId = initial.id;
  let attempt = 0;
  while (!isTerminalMemoryOperation(current)) {
    const delay = memoryOperationPollDelay(attempt);
    await abortableDelay(delay, signal);
    attempt += 1;
    signal.throwIfAborted();
    try {
      current = await api.memoryOperation(sourceId, operationId, signal);
      onUpdate?.(current);
    } catch (error) {
      signal.throwIfAborted();
      const transient = error instanceof TypeError
        || (error instanceof ApiError && (error.status >= 500 || error.code === "unavailable"));
      if (!transient) throw error;
    }
  }
  return current;
};

function MemoryRecordEditor({
  detail,
  actionsAvailable,
  busy,
  onEdit,
  onForget,
  onRestore,
}: {
  readonly detail: MemoryRecordDetail;
  readonly actionsAvailable: boolean;
  readonly busy: boolean;
  readonly onEdit: (patch: MemorySemanticPatch) => void;
  readonly onForget: () => void;
  readonly onRestore: () => void;
}) {
  const record = detail.record;
  const [editing, setEditing] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [text, setText] = useState(record.text);
  const [type, setType] = useState<MemoryRecordType>(record.type);
  const [tags, setTags] = useState(record.tags.join(", "));
  const [salience, setSalience] = useState(String(record.salience));
  const [collection, setCollection] = useState(record.collection ?? "");
  const originalDueAtInput = dateTimeLocalValue(record.dueAt);
  const originalValidFromInput = dateTimeLocalValue(record.validFrom);
  const [dueAt, setDueAt] = useState(originalDueAtInput);
  const [validFrom, setValidFrom] = useState(originalValidFromInput);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedText = text.normalize("NFKC").trim();
    const normalizedTags = [...new Set(tags.split(",").map((tag) => tag.normalize("NFKC").trim()).filter(Boolean))];
    const numericSalience = Number(salience);
    if (!normalizedText) {
      setValidationError("Memory text cannot be empty.");
      return;
    }
    if (!Number.isFinite(numericSalience) || numericSalience < 0 || numericSalience > 1) {
      setValidationError("Salience must be between 0 and 1.");
      return;
    }
    const nextCollection = collection.normalize("NFKC").trim();
    const nextDueAt = dueAt === originalDueAtInput
      ? record.dueAt ?? null
      : dateTimeLocalIso(dueAt);
    const nextValidFrom = validFrom === originalValidFromInput
      ? record.validFrom ?? null
      : dateTimeLocalIso(validFrom);
    const patch: MemorySemanticPatch = {
      ...(normalizedText === record.text ? {} : { text: normalizedText }),
      ...(type === record.type ? {} : { type }),
      ...(JSON.stringify(normalizedTags) === JSON.stringify(record.tags) ? {} : { tags: normalizedTags }),
      ...(numericSalience === record.salience ? {} : { salience: numericSalience }),
      ...((nextCollection || null) === (record.collection ?? null)
        ? {}
        : { collection: nextCollection || null }),
      ...(nextDueAt === (record.dueAt ?? null) ? {} : { dueAt: nextDueAt }),
      ...(nextValidFrom === (record.validFrom ?? null) ? {} : { validFrom: nextValidFrom }),
    };
    if (Object.keys(patch).length === 0) {
      setValidationError("Change at least one semantic field before saving.");
      return;
    }
    setValidationError(undefined);
    onEdit(patch);
  };

  return (
    <article className="memory-record-detail" aria-label="Memory record detail">
      <header>
        <div>
          <span className={`memory-lifecycle is-${record.lifecycle}`}>{record.lifecycle}</span>
          <h2>{record.type} memory</h2>
        </div>
        {record.lifecycle === "active" && actionsAvailable && !editing && (
          <button type="button" className="memory-secondary-button" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </header>

      {editing ? (
        <form className="memory-edit-form" onSubmit={submit}>
          <label className="memory-field-wide"><span>Text</span><textarea value={text} rows={7} maxLength={4_000} onChange={(event) => setText(event.target.value)} /></label>
          <label><span>Type</span><select value={type} onChange={(event) => setType(event.target.value as MemoryRecordType)}><option value="task">Task</option><option value="event">Event</option><option value="note">Note</option></select></label>
          <label><span>Salience</span><input type="number" min="0" max="1" step="0.01" value={salience} onChange={(event) => setSalience(event.target.value)} /></label>
          <label className="memory-field-wide"><span>Tags <small>comma separated</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
          <label><span>Collection</span><input value={collection} placeholder="unfiled" onChange={(event) => setCollection(event.target.value)} /></label>
          <label><span>Due at</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
          <label><span>Valid from</span><input type="datetime-local" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label>
          {validationError && <p className="memory-inline-error" role="alert">{validationError}</p>}
          <footer className="memory-field-wide">
            <button type="button" className="memory-secondary-button" onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>{busy ? "Applying…" : "Save as new memory"}</button>
          </footer>
        </form>
      ) : (
        <>
          <p className="memory-record-full-text">{record.text}</p>
          <dl className="memory-record-facts">
            <div><dt>Status</dt><dd>{record.status}</dd></div>
            <div><dt>Salience</dt><dd>{Math.round(record.salience * 100)}%</dd></div>
            <div><dt>Accesses</dt><dd>{record.accessCount}</dd></div>
            <div><dt>Created</dt><dd>{displayDate(record.createdAt)}</dd></div>
            <div><dt>Last accessed</dt><dd>{displayDate(record.lastAccessedAt)}</dd></div>
            <div><dt>Collection</dt><dd>{record.collection ?? "Unfiled"}</dd></div>
            <div><dt>Due at</dt><dd>{displayDate(record.dueAt)}</dd></div>
            <div><dt>Valid from</dt><dd>{displayDate(record.validFrom)}</dd></div>
          </dl>
          {record.tags.length > 0 && <div className="memory-tags" aria-label="Tags">{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
          {record.source?.conversationId && <p className="memory-provenance">Conversation <code>{record.source.conversationId}</code></p>}
        </>
      )}

      <div className="memory-record-actions">
        {record.lifecycle === "active" && (
          <button type="button" className="memory-danger-button" disabled={!actionsAvailable || busy} onClick={onForget}>
            <Icon name="trash" size={15} />Forget
          </button>
        )}
        {record.lifecycle === "forgotten" && (
          <button type="button" className="memory-secondary-button" disabled={!actionsAvailable || busy} onClick={onRestore}>
            <Icon name="restore" size={15} />Restore as new memory
          </button>
        )}
      </div>

      <section className="memory-history" aria-labelledby="memory-history-title">
        <h3 id="memory-history-title">Action history</h3>
        {detail.history.length === 0 ? <p>No operator actions for this record.</p> : (
          <ol>{detail.history.map((item) => (
            <li key={item.id}>
              <span className={`memory-operation-dot is-${item.status}`} />
              <strong>{item.action}</strong>
              <span>{item.status}</span>
              <time dateTime={item.completedAt}>{displayDate(item.completedAt)}</time>
            </li>
          ))}</ol>
        )}
      </section>
    </article>
  );
}

function CapabilityCard({ capability }: { readonly capability: MemoryCapability }) {
  return (
    <section className="memory-capability-card" aria-labelledby="memory-capability-title">
        <div>
          <span className={`memory-capability-status is-${capability.status}`}>{capability.status}</span>
          <h2 id="memory-capability-title">{capability.backend === "builtin" ? "Built-in memory" : "Supermemory"}</h2>
          <p>{capability.tier ? `${capability.tier} tier` : "Remote backend"} · {capability.graph} graph</p>
        </div>
        <dl>
          <div><dt>Read</dt><dd>{capability.read ? "Available" : "Unavailable"}</dd></div>
          <div><dt>Changes</dt><dd>{capability.actions ? "Enabled" : "Read only"}</dd></div>
        </dl>
        {capability.reason && <p className="memory-capability-reason">{capability.reason}</p>}
    </section>
  );
}

function OverviewView({ availability }: { readonly availability: MemoryAvailability }) {
  const { capability, overview } = availability;
  if (overview === undefined) {
    return (
      <div className="memory-overview">
        <CapabilityCard capability={capability} />
        <div className="memory-empty memory-no-snapshot" role="status">
          <Icon name="memory" size={24} />
          <strong>No record snapshot available</strong>
          <span>{capability.reason ?? "This live memory capability does not expose authoritative record reads."}</span>
        </div>
      </div>
    );
  }
  const { counts, access, embedding } = overview;
  const effectiveCapability = overview.capability;
  return (
    <div className="memory-overview">
      <CapabilityCard capability={effectiveCapability} />
      <section className="memory-metric-grid" aria-label="Memory counts">
        <article><span>Total</span><strong>{counts.total}</strong></article>
        <article><span>Active</span><strong>{counts.active}</strong></article>
        <article><span>Superseded</span><strong>{counts.superseded}</strong></article>
        <article><span>Forgotten</span><strong>{counts.forgotten}</strong></article>
      </section>
      <div className="memory-overview-lower">
        <section>
          <h2>Record types</h2>
          <dl><div><dt>Tasks</dt><dd>{counts.byType.task}</dd></div><div><dt>Events</dt><dd>{counts.byType.event}</dd></div><div><dt>Notes</dt><dd>{counts.byType.note}</dd></div></dl>
        </section>
        <section>
          <h2>Access</h2>
          <dl><div><dt>Total accesses</dt><dd>{access.totalCount}</dd></div><div><dt>Accessed records</dt><dd>{access.accessedRecords}</dd></div></dl>
        </section>
        <section>
          <h2>Embedding</h2>
          {embedding ? <dl><div><dt>Model</dt><dd>{embedding.model ?? "Not reported"}</dd></div><div><dt>Dimensions</dt><dd>{embedding.dimension ?? "Not reported"}</dd></div></dl> : <p>No embedding metadata reported.</p>}
        </section>
      </div>
      <p className="memory-generated-at">Authoritative snapshot · {displayDate(overview.generatedAt)}</p>
    </div>
  );
}

function GraphView({
  graph,
  focusId,
  includeHistory,
  onFocus,
  onIncludeHistory,
}: {
  readonly graph: MemoryGraph;
  readonly focusId: string;
  readonly includeHistory: boolean;
  readonly onFocus: (id: string) => void;
  readonly onIncludeHistory: (include: boolean) => void;
}) {
  const layout = useMemo(() => layoutMemoryGraph(graph), [graph]);
  const labels = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.label])), [graph.nodes]);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => setZoom(1), [graph]);
  const resetZoom = () => {
    setZoom(1);
    canvasRef.current?.scrollTo?.({ left: 0, top: 0 });
  };
  return (
    <div className="memory-graph-view">
      <div className="memory-graph-toolbar">
        <span className={`memory-fidelity is-${graph.fidelity}`}>{graph.fidelity} fidelity</span>
        <label><input type="checkbox" checked={includeHistory} onChange={(event) => onIncludeHistory(event.target.checked)} />Include lifecycle history</label>
        <div className="memory-graph-zoom" role="group" aria-label="Graph zoom controls">
          <button type="button" aria-label="Zoom graph out" disabled={zoom <= 0.6} onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.2).toFixed(1))))}>−</button>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="Zoom graph in" disabled={zoom >= 2} onClick={() => setZoom((value) => Math.min(2, Number((value + 0.2).toFixed(1))))}>+</button>
          <button type="button" onClick={resetZoom}>Reset</button>
        </div>
        {focusId && <button type="button" className="memory-secondary-button" onClick={() => onFocus("")}>Clear focus</button>}
      </div>
      {graph.truncated && <p className="memory-graph-truncated" role="status">This graph reached the bounded response limit. Focus a node to narrow it.</p>}
      {graph.fidelity === "unavailable" ? (
        <div className="memory-empty"><Icon name="graph" size={24} /><strong>Graph unavailable</strong><span>This memory tier does not expose a canonical graph.</span></div>
      ) : graph.nodes.length === 0 ? (
        <div className="memory-empty"><Icon name="graph" size={24} /><strong>No graph nodes</strong><span>Captured entities and memory links will appear here.</span></div>
      ) : (
        <div className="memory-graph-content">
          <div className="memory-graph-lists">
            <section aria-labelledby="memory-graph-nodes-title">
              <h2 id="memory-graph-nodes-title">Nodes <span>{graph.nodes.length}</span></h2>
              <ol>{graph.nodes.map((node) => (
                <li key={`${node.kind}:${node.id}`}>
                  <button type="button" aria-pressed={focusId === node.id} onClick={() => onFocus(node.id)}>
                    <span className={`memory-node-kind is-${node.kind}`} />
                    <span><strong>{node.label}</strong><small>{node.kind === "memory" ? `${node.recordType} · ${node.lifecycle}` : node.entityType ?? "entity"}</small></span>
                  </button>
                </li>
              ))}</ol>
            </section>
            <section aria-labelledby="memory-graph-edges-title">
              <h2 id="memory-graph-edges-title">Relationships <span>{graph.edges.length}</span></h2>
              {graph.edges.length === 0 ? <p>No relationships in this view.</p> : <ol>{graph.edges.map((edge, index) => (
                <li key={`${edge.source}:${edge.kind}:${edge.target}:${index}`}>
                  <span>{labels.get(edge.source) ?? edge.source}</span>
                  <strong>{edge.label ?? edge.kind}</strong>
                  <span>{labels.get(edge.target) ?? edge.target}</span>
                </li>
              ))}</ol>}
            </section>
          </div>
          <div ref={canvasRef} className="memory-graph-canvas" tabIndex={0} aria-label="Pan the zoomed memory graph with touch or scroll. Complete node and relationship lists are alongside it.">
            <svg
              className="memory-graph-svg"
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              style={{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }}
              role="img"
              aria-labelledby="memory-graph-svg-title memory-graph-svg-description"
            >
              <title id="memory-graph-svg-title">Memory relationship graph</title>
              <desc id="memory-graph-svg-description">{graph.nodes.length} nodes and {graph.edges.length} relationships. Use the adjacent lists for complete labels.</desc>
              <defs><marker id="memory-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
              <g className="memory-graph-edges">{graph.edges.map((edge, index) => {
                const source = layout.byId.get(edge.source);
                const target = layout.byId.get(edge.target);
                if (!source || !target) return null;
                return <line key={`${edge.source}:${edge.target}:${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd="url(#memory-arrow)" />;
              })}</g>
              <g className="memory-graph-nodes">{layout.positions.map(({ node, x, y }) => (
                <g key={`${node.kind}:${node.id}`} transform={`translate(${x} ${y})`} className={`is-${node.kind}${focusId === node.id ? " is-focused" : ""}`}>
                  <title>{node.label}</title>
                  {node.kind === "entity" ? <circle r="24" /> : <rect x="-72" y="-25" width="144" height="50" rx="13" />}
                  <text textAnchor="middle" dominantBaseline="middle">{truncateMemoryGraphLabel(node.label)}</text>
                </g>
              ))}</g>
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryForgetDialog({
  pending,
  onClose,
  onConfirm,
}: {
  readonly pending: PendingForget;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(MEMORY_FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && (
        document.activeElement === first || !dialogRef.current.contains(document.activeElement)
      )) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (
        document.activeElement === last || !dialogRef.current.contains(document.activeElement)
      )) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  return (
    <div className="dialog-layer memory-confirmation-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="memory-forget-title"
        aria-describedby="memory-forget-description"
        className="memory-confirmation"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Icon name="trash" size={22} />
        <h2 id="memory-forget-title">Forget this memory?</h2>
        <p id="memory-forget-description">{pending.confirmation.message} The record remains as a forgotten tombstone and can be restored later.</p>
        <small>Confirmation expires {displayDate(pending.confirmation.expiresAt)}.</small>
        <footer>
          <button type="button" className="memory-secondary-button" onClick={onClose}>Cancel</button>
          <button ref={confirmRef} type="button" className="memory-danger-button" onClick={onConfirm}>Confirm forget</button>
        </footer>
      </section>
    </div>
  );
}

export function MemoryWorkspace({
  focusAgentPickerOnMount = false,
  onAgentPickerFocusRestored,
  onAgentPickerSelection,
}: {
  readonly focusAgentPickerOnMount?: boolean;
  readonly onAgentPickerFocusRestored?: () => void;
  readonly onAgentPickerSelection?: () => void;
}) {
  const store = useConsoleStore();
  const sourceId = store.workspaceRoute.kind === "memory" ? store.workspaceRoute.sourceId : null;
  const agent = store.agents.find((candidate) => candidate.sourceId === sourceId);
  const live = sourceId !== null && agent !== undefined
    && agent.status !== "offline" && store.connection === "live";
  const [tab, setTab] = useState<MemoryTab>("overview");
  const [mobileAgents, setMobileAgents] = useState(false);
  const [availability, setAvailability] = useState<MemoryAvailability>();
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string>();
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState<"" | MemoryLifecycle>("");
  const [recordType, setRecordType] = useState<"" | MemoryRecordType>("");
  const [collection, setCollection] = useState("");
  const [records, setRecords] = useState<readonly MemoryRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedRecordId, setSelectedRecordId] = useState<string>();
  const [detail, setDetail] = useState<MemoryRecordDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [graph, setGraph] = useState<MemoryGraph>();
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string>();
  const [graphFocusId, setGraphFocusId] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [operation, setOperation] = useState<MemoryOperation>();
  const [actionError, setActionError] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingForget, setPendingForget] = useState<PendingForget>();
  const mutationController = useRef<AbortController | undefined>(undefined);
  const recordsPageController = useRef<AbortController | undefined>(undefined);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mobileAgentOpenerRef = useRef<HTMLButtonElement>(null);
  const mobileAgentDialogRef = useRef<HTMLDivElement>(null);
  const closeMobileAgentDialog = () => {
    setMobileAgents(false);
    mobileAgentOpenerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!focusAgentPickerOnMount) return;
    mobileAgentOpenerRef.current?.focus();
    onAgentPickerFocusRestored?.();
  }, [focusAgentPickerOnMount, onAgentPickerFocusRestored]);

  useLayoutEffect(() => {
    if (!mobileAgents) return;
    const prior = mobileAgentOpenerRef.current;
    const dialog = mobileAgentDialogRef.current;
    const focusable = dialog === null
      ? []
      : [...dialog.querySelectorAll<HTMLElement>(MEMORY_FOCUSABLE)];
    (focusable[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const currentDialog = mobileAgentDialogRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileAgentDialog();
        return;
      }
      if (event.key !== "Tab" || currentDialog === null) return;
      const currentFocusable = [...currentDialog.querySelectorAll<HTMLElement>(MEMORY_FOCUSABLE)];
      const first = currentFocusable[0];
      const last = currentFocusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        currentDialog.focus();
      } else if (event.shiftKey && (
        document.activeElement === first || !currentDialog.contains(document.activeElement)
      )) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (
        document.activeElement === last || !currentDialog.contains(document.activeElement)
      )) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (prior?.isConnected) prior.focus();
    };
  }, [mobileAgents]);

  const moveMemoryTab = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: MemoryTab,
  ) => {
    const currentIndex = MEMORY_TABS.indexOf(current);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % MEMORY_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + MEMORY_TABS.length) % MEMORY_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = MEMORY_TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = MEMORY_TABS[nextIndex]!;
    setTab(next);
    tabRefs.current[nextIndex]?.focus();
  };

  const recordQuery = useMemo<MemoryRecordQuery>(() => ({
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(recordType ? { type: recordType } : {}),
    ...(collection.trim() ? { collection: collection.trim() } : {}),
    limit: 50,
  }), [collection, lifecycle, query, recordType]);

  useEffect(() => {
    recordsPageController.current?.abort();
    setSelectedRecordId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
  }, [collection, lifecycle, query, recordType, sourceId]);

  useEffect(() => {
    mutationController.current?.abort();
    recordsPageController.current?.abort();
    setAvailability(undefined);
    setOverviewError(undefined);
    setRecords([]);
    setRecordsError(undefined);
    setNextCursor(undefined);
    setSelectedRecordId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setGraph(undefined);
    setGraphError(undefined);
    setGraphFocusId("");
    setOperation(undefined);
    setActionError(undefined);
    setActionBusy(false);
    setPendingForget(undefined);
    setMobileAgents(false);
    if (!live) {
      setOverviewLoading(false);
      setRecordsLoading(false);
      setDetailLoading(false);
      setGraphLoading(false);
    }
    return () => {
      mutationController.current?.abort();
      recordsPageController.current?.abort();
    };
  }, [live, sourceId]);

  useEffect(() => {
    setAvailability(undefined);
    setOverviewError(undefined);
    if (!live || sourceId === null) return;
    const controller = new AbortController();
    setOverviewLoading(true);
    void api.memoryOverview(sourceId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setAvailability(next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setOverviewError(memoryWorkspaceError(error, "Could not load live memory."));
    }).finally(() => {
      if (!controller.signal.aborted) setOverviewLoading(false);
    });
    return () => controller.abort();
  }, [live, refreshToken, sourceId]);

  useEffect(() => {
    setRecords([]);
    setNextCursor(undefined);
    setRecordsError(undefined);
    if (tab !== "records" || !live || sourceId === null || availability?.capability.read !== true) {
      setRecordsLoading(false);
      return;
    }
    const controller = new AbortController();
    setRecordsLoading(true);
    const timer = window.setTimeout(() => {
      void api.memoryRecords(sourceId, recordQuery, controller.signal).then((page) => {
        if (controller.signal.aborted) return;
        setRecords(page.records);
        setNextCursor(page.nextCursor);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setRecordsError(memoryWorkspaceError(error, "Could not load memory records."));
      }).finally(() => {
        if (!controller.signal.aborted) setRecordsLoading(false);
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [availability?.capability.read, live, recordQuery, refreshToken, sourceId, tab]);

  useEffect(() => {
    setDetail(undefined);
    setDetailError(undefined);
    if (tab !== "records" || !live || sourceId === null
      || availability?.capability.read !== true || selectedRecordId === undefined) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    void api.memoryRecord(sourceId, selectedRecordId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setDetailError(memoryWorkspaceError(error, "Could not load this memory record."));
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [availability?.capability.read, live, refreshToken, selectedRecordId, sourceId, tab]);

  useEffect(() => {
    setGraph(undefined);
    setGraphError(undefined);
    if (tab !== "graph" || !live || sourceId === null || availability?.capability.read !== true) {
      setGraphLoading(false);
      return;
    }
    const controller = new AbortController();
    setGraphLoading(true);
    void api.memoryGraph(sourceId, {
      ...(graphFocusId ? { focusId: graphFocusId } : {}),
      includeHistory,
      limit: 100,
    }, controller.signal).then((next) => {
      if (!controller.signal.aborted) setGraph(next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setGraphError(memoryWorkspaceError(error, "Could not load the memory graph."));
    }).finally(() => {
      if (!controller.signal.aborted) setGraphLoading(false);
    });
    return () => controller.abort();
  }, [availability?.capability.read, graphFocusId, includeHistory, live, refreshToken, sourceId, tab]);

  const loadMore = () => {
    if (!live || sourceId === null || nextCursor === undefined || recordsLoading) return;
    recordsPageController.current?.abort();
    const controller = new AbortController();
    recordsPageController.current = controller;
    setRecordsLoading(true);
    setRecordsError(undefined);
    void api.memoryRecords(sourceId, { ...recordQuery, before: nextCursor }, controller.signal).then((page) => {
      if (controller.signal.aborted || store.workspaceRoute.kind !== "memory" || store.workspaceRoute.sourceId !== sourceId) return;
      const ids = new Set(records.map((record) => record.id));
      setRecords((current) => [...current, ...page.records.filter((record) => !ids.has(record.id))]);
      setNextCursor(page.nextCursor);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setRecordsError(memoryWorkspaceError(error, "Could not load more memory records."));
    }).finally(() => {
      if (recordsPageController.current === controller) {
        recordsPageController.current = undefined;
        if (!controller.signal.aborted) setRecordsLoading(false);
      }
    });
  };

  const completeAdmission = async (
    admission: MemoryMutationAdmission,
    controller: AbortController,
  ): Promise<void> => {
    if (admission.kind === "confirmation_required") {
      throw new Error("unexpected_memory_confirmation");
    }
    setOperation(admission.operation);
    const terminal = await pollMemoryOperation(
      sourceId!,
      admission.operation,
      controller.signal,
      setOperation,
    );
    controller.signal.throwIfAborted();
    setOperation(terminal);
    if (terminal.status === "failed") setActionError(operationError(terminal));
    if (terminal.status === "succeeded" && terminal.resultRecordId !== undefined) {
      setSelectedRecordId(terminal.resultRecordId);
    }
    setRefreshToken((value) => value + 1);
    window.dispatchEvent(new CustomEvent("mono-agent:notice", {
      detail: { message: terminal.status === "succeeded" ? "Memory updated from authoritative state." : operationError(terminal) },
    }));
  };

  const runAction = async (
    action: (signal: AbortSignal) => Promise<MemoryMutationAdmission>,
  ): Promise<MemoryMutationAdmission | undefined> => {
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    setActionBusy(true);
    setActionError(undefined);
    try {
      const admission = await action(controller.signal);
      if (admission.kind === "queued") await completeAdmission(admission, controller);
      return admission;
    } catch (error) {
      if (!controller.signal.aborted) {
        setOperation(undefined);
        setActionError(memoryWorkspaceError(error, "The memory action could not be completed."));
      }
      return undefined;
    } finally {
      if (mutationController.current === controller) {
        mutationController.current = undefined;
        if (!controller.signal.aborted) setActionBusy(false);
      }
    }
  };

  const editRecord = (patch: MemorySemanticPatch) => {
    if (!detail || sourceId === null) return;
    void runAction((signal) => api.editMemoryRecord(sourceId, detail.record.id, {
      expectedRevision: detail.record.revision,
      idempotencyKey: memoryActionKey(),
      patch,
    }, signal));
  };

  const beginForget = () => {
    if (!detail || sourceId === null) return;
    const input: MemoryActionInput = {
      expectedRevision: detail.record.revision,
      idempotencyKey: memoryActionKey(),
    };
    void runAction((signal) => api.forgetMemoryRecord(sourceId, detail.record.id, input, signal)).then((admission) => {
      if (admission?.kind === "confirmation_required") {
        setPendingForget({ recordId: detail.record.id, input, confirmation: admission.confirmation });
      }
    });
  };

  const confirmForget = () => {
    if (!pendingForget || sourceId === null) return;
    const pending = pendingForget;
    setPendingForget(undefined);
    void runAction((signal) => api.forgetMemoryRecord(sourceId, pending.recordId, {
      ...pending.input,
      confirmationToken: pending.confirmation.token,
    }, signal));
  };

  const restoreRecord = () => {
    if (!detail || sourceId === null) return;
    void runAction((signal) => api.restoreMemoryRecord(sourceId, detail.record.id, {
      expectedRevision: detail.record.revision,
      idempotencyKey: memoryActionKey(),
    }, signal));
  };

  const refreshMemory = () => {
    if (!live || overviewLoading || actionBusy) return;
    recordsPageController.current?.abort();
    recordsPageController.current = undefined;
    setRefreshToken((value) => value + 1);
  };

  const actionsAvailable = live
    && (availability?.overview?.capability ?? availability?.capability)?.actions === true;
  const unavailableMessage = agent === undefined
    ? "This route does not match a discovered live agent."
    : agent.status === "offline"
      ? `${agent.label} is offline. Memory snapshots are cleared until it reconnects.`
      : store.connection !== "live"
        ? "The console is disconnected. Memory snapshots are cleared until the live connection returns."
        : undefined;

  return (
    <main className="memory-workspace" aria-label="Memory workspace">
      <header className="memory-workspace-header">
        <div className="memory-mobile-navigation">
          <button
            ref={mobileAgentOpenerRef}
            type="button"
            className="icon-button"
            aria-label="Choose memory agent"
            aria-expanded={mobileAgents}
            aria-controls="memory-agent-dialog"
            onClick={() => setMobileAgents(true)}
          ><Icon name="agent" size={18} /></button>
        </div>
        <div className="memory-title">
          <span className="eyebrow">Live operator</span>
          <h1>Memory</h1>
          <span>{agent?.label ?? sourceId ?? "No agent"}</span>
        </div>
        <div className="memory-header-actions">
          <button
            type="button"
            className="memory-secondary-button memory-refresh-button"
            disabled={!live || overviewLoading || actionBusy}
            aria-label={overviewLoading ? "Refreshing live memory" : "Refresh live memory"}
            onClick={refreshMemory}
          >
            <Icon name="restore" size={15} /><span>{overviewLoading ? "Refreshing…" : "Refresh"}</span>
          </button>
          <button type="button" className="memory-conversation-exit" onClick={store.openConversationIndex}>
            <Icon name="threads" size={16} />Conversations
          </button>
        </div>
      </header>

      <nav className="memory-tabs" role="tablist" aria-label="Memory views">
        {MEMORY_TABS.map((value, index) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`memory-tab-${value}`}
            type="button"
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            aria-selected={tab === value}
            aria-controls={`memory-panel-${value}`}
            onClick={() => setTab(value)}
            onKeyDown={(event) => moveMemoryTab(event, value)}
          >
            <Icon name={value === "graph" ? "graph" : value === "records" ? "file" : "memory"} size={15} />
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      {unavailableMessage && <div className="memory-connection-message" role="status"><Icon name="memory" size={19} /><span>{unavailableMessage}</span></div>}
      {actionError && <div className="memory-action-error" role="alert"><span>{actionError}</span><button type="button" aria-label="Dismiss memory error" onClick={() => setActionError(undefined)}><Icon name="close" size={14} /></button></div>}
      {operation && !isTerminalMemoryOperation(operation) && <div className="memory-operation-banner" role="status"><span className="workspace-search-progress" />{operation.action} · {operation.status}</div>}

      <section
        id="memory-panel-overview"
        className="memory-panel is-overview"
        role="tabpanel"
        tabIndex={0}
        aria-labelledby="memory-tab-overview"
        hidden={tab !== "overview"}
      >
        {tab === "overview" && (
          overviewLoading ? <div className="memory-loading" role="status">Loading live memory…</div>
            : overviewError ? <div className="memory-error" role="alert">{overviewError}</div>
              : availability ? <OverviewView availability={availability} />
                : !unavailableMessage && <div className="memory-empty"><Icon name="memory" size={24} /><strong>No memory overview</strong></div>
        )}
      </section>

      <section
        id="memory-panel-records"
        className="memory-panel is-records"
        role="tabpanel"
        tabIndex={0}
        aria-labelledby="memory-tab-records"
        hidden={tab !== "records"}
      >
        {tab === "records" && (
          overviewLoading && availability === undefined
            ? <div className="memory-loading" role="status">Checking memory availability…</div>
            : overviewError
              ? <div className="memory-error" role="alert">{overviewError}</div>
              : availability?.capability.read === false
                ? <div className="memory-empty memory-read-unavailable" role="status"><Icon name="file" size={24} /><strong>Record reads unavailable</strong><span>{availability.capability.reason ?? `Memory is ${availability.capability.status} for this agent.`}</span></div>
                : <div className={`memory-records-view${selectedRecordId ? " has-detail" : ""}`}>
            <div className="memory-records-browser">
              <div className="memory-record-filters">
                <label className="memory-search"><Icon name="search" size={15} /><span className="sr-only">Search memory records</span><input type="search" value={query} placeholder="Search memory text" onChange={(event) => setQuery(event.target.value)} /></label>
                <label><span className="sr-only">Lifecycle</span><select aria-label="Memory lifecycle" value={lifecycle} onChange={(event) => setLifecycle(event.target.value as "" | MemoryLifecycle)}><option value="">All lifecycle</option><option value="active">Active</option><option value="superseded">Superseded</option><option value="forgotten">Forgotten</option></select></label>
                <label><span className="sr-only">Record type</span><select aria-label="Memory type" value={recordType} onChange={(event) => setRecordType(event.target.value as "" | MemoryRecordType)}><option value="">All types</option><option value="task">Tasks</option><option value="event">Events</option><option value="note">Notes</option></select></label>
                <label><span className="sr-only">Collection</span><input aria-label="Memory collection" value={collection} placeholder="Collection" onChange={(event) => setCollection(event.target.value)} /></label>
              </div>
              {recordsError && <div className="memory-error" role="alert">{recordsError}</div>}
              <div className="memory-record-list" aria-busy={recordsLoading}>
                {records.map((record) => (
                  <article key={record.id} className={selectedRecordId === record.id ? "is-active" : ""}>
                    <button type="button" onClick={() => setSelectedRecordId(record.id)} aria-pressed={selectedRecordId === record.id}>
                      <span className="memory-record-list-title"><strong>{record.text}</strong><span className={`memory-lifecycle is-${record.lifecycle}`}>{record.lifecycle}</span></span>
                      <span className="memory-record-list-meta"><span>{record.type}</span><span>{record.status}</span><span>{record.collection ?? "Unfiled"}</span><time dateTime={record.createdAt}>{displayDate(record.createdAt)}</time></span>
                      {record.tags.length > 0 && <span className="memory-record-list-tags">{record.tags.join(" · ")}</span>}
                    </button>
                  </article>
                ))}
                {recordsLoading && <div className="memory-loading" role="status">Loading records…</div>}
                {!recordsLoading && records.length === 0 && !recordsError && live && <div className="memory-empty"><Icon name="file" size={22} /><strong>No matching memory records</strong><span>Try another search or filter.</span></div>}
                {nextCursor && <button type="button" className="memory-load-more" disabled={recordsLoading} onClick={loadMore}>Load more records</button>}
              </div>
            </div>
            <div className="memory-record-detail-shell">
              {detailLoading ? <div className="memory-loading" role="status">Loading record…</div>
                : detailError ? <div className="memory-error" role="alert">{detailError}</div>
                  : detail ? <MemoryRecordEditor key={`${detail.record.id}:${detail.record.revision}`} detail={detail} actionsAvailable={actionsAvailable} busy={actionBusy} onEdit={editRecord} onForget={beginForget} onRestore={restoreRecord} />
                    : <div className="memory-empty"><Icon name="file" size={22} /><strong>Select a memory</strong><span>Inspect its authoritative fields and action history.</span></div>}
            </div>
          </div>
        )}
      </section>

      <section
        id="memory-panel-graph"
        className="memory-panel is-graph"
        role="tabpanel"
        tabIndex={0}
        aria-labelledby="memory-tab-graph"
        hidden={tab !== "graph"}
      >
        {tab === "graph" && (
          overviewLoading && availability === undefined
            ? <div className="memory-loading" role="status">Checking memory availability…</div>
            : overviewError
              ? <div className="memory-error" role="alert">{overviewError}</div>
              : availability?.capability.read === false
                ? <div className="memory-empty memory-read-unavailable" role="status"><Icon name="graph" size={24} /><strong>Graph reads unavailable</strong><span>{availability.capability.reason ?? `Memory is ${availability.capability.status} for this agent.`}</span></div>
                : graphLoading ? <div className="memory-loading" role="status">Loading graph…</div>
                  : graphError ? <div className="memory-error" role="alert">{graphError}</div>
                    : graph ? <GraphView graph={graph} focusId={graphFocusId} includeHistory={includeHistory} onFocus={setGraphFocusId} onIncludeHistory={setIncludeHistory} />
                      : !unavailableMessage && <div className="memory-empty"><Icon name="graph" size={24} /><strong>No memory graph</strong></div>
        )}
      </section>

      <div
        ref={mobileAgentDialogRef}
        id="memory-agent-dialog"
        className={`mobile-agent-drawer memory-agent-drawer${mobileAgents ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Choose memory agent"
        aria-hidden={!mobileAgents}
        inert={!mobileAgents}
        tabIndex={-1}
      >
        <MobileAgentPicker onSelect={() => {
          onAgentPickerSelection?.();
          closeMobileAgentDialog();
        }} />
      </div>
      {mobileAgents && <button type="button" className="drawer-scrim" onClick={closeMobileAgentDialog} aria-label="Close agent picker" />}

      {pendingForget && <MemoryForgetDialog pending={pendingForget} onClose={() => setPendingForget(undefined)} onConfirm={confirmForget} />}
    </main>
  );
}
