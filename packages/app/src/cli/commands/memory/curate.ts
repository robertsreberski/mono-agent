import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { CURATE_DISCARD_REASONS } from "@mono-agent/memory/bujo";
import type {
  CurateProposal,
  CurateDiscard,
  CurateOperatorMerge,
  CurateOwnerAssociation,
  CuratePersonAssociation,
} from "@mono-agent/memory/bujo";

import type { BujoModule } from "./bundle.js";
import { assertNoLiveConfiguredAgent, memoryRegistryDirs, previewRecallSettings } from "./context.js";
import {
  canonicalProspectivePath,
  fsyncParentDirectory,
  hasExactKeys,
  isCanonicalIso,
  isObject,
  isSameOrUnderDirectory,
  isSha256,
  MEMORY_ID_RE,
  memoryRootFingerprint,
  readPinnedFile,
  readPrivateJson,
  writePrivateJsonExclusive,
} from "./private-plan.js";
import { write } from "./render.js";
import { exists, loadBujoModule, loadMemoryRecallModule } from "./store-access.js";
import type { MemoryCommandContext, RunMemoryCommandInput } from "./types.js";
const MAX_CURATE_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_CURATE_MERGE_FILE_BYTES = 64 * 1024;

interface CuratePlan {
  readonly schemaVersion: 1;
  readonly operation: "curate";
  readonly rootFingerprint: string;
  readonly sourceFingerprint: string;
  readonly model: string;
  readonly createdAt: string;
  readonly proposals: readonly CurateProposal[];
  readonly discarded: readonly CurateDiscard[];
  /** Operator-authoritative entity merges; absent in plans without any. */
  readonly operatorMerges?: readonly CurateOperatorMerge[];
  /** Reviewed `person:owner` association backfill (`--owner-backfill`); absent otherwise. */
  readonly ownerAssociations?: readonly CurateOwnerAssociation[];
  /** Reviewed person links (`--link-people`); absent otherwise. */
  readonly personAssociations?: readonly CuratePersonAssociation[];
  readonly planDigest: string;
}

function curatePlanDigest(plan: Omit<CuratePlan, "planDigest">): string {
  return createHash("sha256").update(JSON.stringify({ ...plan, proposals: plan.proposals.map(({ accepted: _accepted, ...immutable }) => immutable),
    ...(plan.operatorMerges === undefined ? {} : { operatorMerges: plan.operatorMerges.map(({ accepted: _accepted, ...immutable }) => immutable) }),
    ...(plan.ownerAssociations === undefined ? {} : { ownerAssociations: plan.ownerAssociations.map(({ accepted: _accepted, ...immutable }) => immutable) }),
    ...(plan.personAssociations === undefined ? {} : { personAssociations: plan.personAssociations.map(({ accepted: _accepted, ...immutable }) => immutable) }) })).digest("hex");
}

/** Ids of the plan's drop proposals, optionally only the accepted ones. */
function curateDropIds(proposals: readonly CurateProposal[], acceptedOnly: boolean): Set<string> {
  return new Set(proposals.filter(({ action, accepted }) => action === "drop" && (accepted || !acceptedOnly)).map(({ source }) => source.id));
}

/**
 * Apply cannot both drop a line and link it to the owner or a person. An
 * accepted drop wins: associations for the same id are set to not accepted.
 */
function withAcceptedDropsWinning(plan: CuratePlan): CuratePlan {
  if (plan.ownerAssociations === undefined && plan.personAssociations === undefined) return plan;
  const dropped = curateDropIds(plan.proposals, true);
  const conflicts = (list: readonly { readonly id: string; readonly accepted: boolean }[] | undefined) =>
    list?.some(({ id, accepted }) => accepted && dropped.has(id)) === true;
  if (!conflicts(plan.ownerAssociations) && !conflicts(plan.personAssociations)) return plan;
  const release = <T extends { readonly id: string; readonly accepted: boolean }>(association: T): T =>
    association.accepted && dropped.has(association.id) ? { ...association, accepted: false } : association;
  return { ...plan, ...(plan.ownerAssociations === undefined ? {} : { ownerAssociations: plan.ownerAssociations.map(release) }),
    ...(plan.personAssociations === undefined ? {} : { personAssociations: plan.personAssociations.map(release) }) };
}

/** Operator merges from repeated `--merge` flags and an optional private merge file. */
async function readCurateOperatorMerges(context: MemoryCommandContext, input: RunMemoryCommandInput, bujo: BujoModule): Promise<CurateOperatorMerge[]> {
  const specs = [...(input.curateMerges ?? [])];
  if (input.curateMergeFile !== undefined) {
    specs.push(...(await readPinnedFile(resolve(context.cwd, input.curateMergeFile), MAX_CURATE_MERGE_FILE_BYTES, false)).split(/\r?\n/gu));
  }
  return bujo.parseCurateOperatorMerges(specs, input.allowCrossType === true);
}

function parseCuratePlan(value: unknown): CuratePlan {
  const planKeys = ["schemaVersion", "operation", "rootFingerprint", "sourceFingerprint", "model", "createdAt", "proposals", "discarded", "planDigest"];
  const optionalKeys = ["operatorMerges", "ownerAssociations", "personAssociations"].filter((key) => isObject(value) && Object.hasOwn(value, key));
  if (!isObject(value) || !hasExactKeys(value, [...planKeys, ...optionalKeys])
    || (value.operatorMerges !== undefined && (!Array.isArray(value.operatorMerges) || value.operatorMerges.length > 512))
    || (value.ownerAssociations !== undefined && (!Array.isArray(value.ownerAssociations) || value.ownerAssociations.length > 8192))
    || (value.personAssociations !== undefined && (!Array.isArray(value.personAssociations) || value.personAssociations.length > 8192))
    || value.schemaVersion !== 1 || value.operation !== "curate" || !isSha256(value.rootFingerprint)
    || !isSha256(value.sourceFingerprint) || typeof value.model !== "string" || value.model.length > 160
    || typeof value.createdAt !== "string" || !isCanonicalIso(value.createdAt)
    || !isSha256(value.planDigest)
    || !Array.isArray(value.proposals) || value.proposals.length > 8192
    || !Array.isArray(value.discarded) || value.discarded.length > 16384
    || value.discarded.some((entry: unknown) => !isObject(entry) || !hasExactKeys(entry, ["id", "reason"])
      || typeof entry.id !== "string" || (entry.id !== "unbound" && !MEMORY_ID_RE.test(entry.id))
      || !(typeof entry.reason === "string" && (CURATE_DISCARD_REASONS as readonly string[]).includes(entry.reason)))) {
    throw new Error("invalid curate plan");
  }
  const bujo = value.proposals as CurateProposal[];
  const ids = new Set<string>();
  for (const proposal of bujo) {
    if (!isObject(proposal) || !(["action", "accepted", "source"].every((key) => Object.hasOwn(proposal, key)) && Object.keys(proposal).every((key) => ["action", "accepted", "source", "reason", "text", "labels", "mergeEntity", "type"].includes(key)))) throw new Error("invalid proposal shape");
    const source = proposal.source;
    if (!isObject(source) || !(hasExactKeys(source, ["id", "file", "line", "text", "textHash", "createdAt", "status", "refs"]) || hasExactKeys(source, ["id", "file", "line", "text", "textHash", "createdAt", "status", "refs", "type"]))) throw new Error("invalid proposal source");
    if (ids.has(source.id as string)) throw new Error("duplicate proposal id");
    ids.add(source.id as string);
  }
  const parsed = value as unknown as CuratePlan;
  const { planDigest, ...payload } = parsed;
  if (curatePlanDigest(payload) !== planDigest) throw new Error("curate plan checksum mismatch");
  return parsed;
}

export function curateRecoveredFailureReason(error: unknown): string {
  return error instanceof Error && "cause" in error && error.cause !== undefined
    ? "The apply failure cause was withheld because it may contain private memory text."
    : "An interrupted apply was recovered; its original cause was not retained.";
}

export async function runMemoryCurate(context: MemoryCommandContext, rest: readonly string[], input: RunMemoryCommandInput): Promise<number> {
  const operation = rest[0];
  const memory = context.config.memory;
  if (memory?.mode !== "bujo" || memory.embeddings === undefined) {
    write(input.json, { operation: `curate-${operation ?? "unknown"}`, status: "failed", code: "curate_requires_bujo" },
      () => "Memory curate requires a configured BuJo store with embeddings.\n");
    return 1;
  }
  try {
    const bujo = await loadBujoModule();
    const root = bujo.resolveExplicitMemoryCurateRoot(resolve(context.cwd, memory.path));
    if (operation === "prepare") {
      const planPath = await canonicalProspectivePath(resolve(context.cwd, input.planPath!));
      if (isSameOrUnderDirectory(root, planPath)) throw new Error("plan cannot be inside memory root");
      if (!input.dryRun && await exists(planPath)) throw new Error(`curate plan already exists at ${planPath}; choose a new --plan path.`);
      const operatorMerges = await readCurateOperatorMerges(context, input, bujo);
      // Deterministic and model-free: only lines whose own source proves the owner is the subject.
      const ownerScan = input.ownerBackfill === true ? bujo.proposeOwnerAssociations(root) : undefined;
      const scannedOwners = ownerScan?.associations ?? [];
      // Deterministic and model-free: lines naming exactly one known person (`--limit 0` only).
      const peopleScan = input.linkPeople === true ? bujo.proposePersonAssociations(root, operatorMerges) : undefined;
      const scannedPeople = peopleScan?.associations ?? [];
      // Deterministic and model-free: every open task line (in the window) as a history note.
      const tasksScan = input.tasksToNotes === true ? bujo.proposeTasksToNotes(root, {
        ...(input.tasksBefore === undefined ? {} : { before: new Date(input.tasksBefore) }),
        ...(input.captureOnly === true ? { captureOnly: true } : {}) }) : undefined;
      // A line this plan proposes to drop gets no owner or person link proposal.
      const ownersFor = (candidates: readonly CurateProposal[]): readonly CurateOwnerAssociation[] => {
        const dropped = curateDropIds(candidates, false);
        return dropped.size === 0 ? scannedOwners : scannedOwners.filter(({ id }) => !dropped.has(id));
      };
      const peopleFor = (candidates: readonly CurateProposal[]): readonly CuratePersonAssociation[] => {
        const dropped = curateDropIds(candidates, false);
        return dropped.size === 0 ? scannedPeople : scannedPeople.filter(({ id }) => !dropped.has(id));
      };
      // `--limit 0` sends no line to a model: operator merges, owner backfill and
      // a bounded pass of coarse person labels (oldest first, or --select recent).
      const modelPass = input.limit !== 0 && tasksScan === undefined;
      const inspected = bujo.inspectCurateSource(root, modelPass ? input.limit ?? 120 : 1,
        modelPass ? input.curateSelect : "oldest", input.semanticReview === true);
      const snapshot = modelPass ? inspected : { ...inspected, lines: [] };
      bujo.previewCurateMutations(root, [], undefined, operatorMerges, scannedOwners, scannedPeople);
      if (Buffer.byteLength(JSON.stringify(snapshot.lines), "utf8") > MAX_CURATE_PLAN_BYTES / 2) {
        throw new Error("curate source exceeds private plan bound");
      }
      const curateOptions = { ...memory.capture, ...(input.semanticReview === true ? { semanticReview: true } : {}) };
      const estimate = bujo.curateEstimate(snapshot, curateOptions);
      const model = tasksScan !== undefined ? "none" : input.model ?? memory.llm?.model ?? (modelPass ? undefined : "none");
      if (model === undefined) throw new Error("memory LLM not configured");
      const estimateText = `Curate estimate: ${estimate.lines} lines, ${estimate.calls} calls, ~${estimate.inputTokens} input / ~${estimate.outputTokens} output tokens; cost unknown. Selected buckets: ${JSON.stringify(modelPass ? snapshot.selected : {})}. Skipped canonical lines: ${JSON.stringify(snapshot.skipped)}.\n`;
      if (input.dryRun) {
        write(input.json, { operation: "curate-prepare", status: "estimated", model, estimate, skipped: snapshot.skipped, selected: modelPass ? snapshot.selected : {},
          ...(ownerScan === undefined ? {} : { ownerBackfill: ownerScan.counts }),
          ...(peopleScan === undefined ? {} : { linkPeople: peopleScan.counts }),
          ...(tasksScan === undefined ? {} : { tasksToNotes: tasksScan.counts }) },
          () => `${estimateText}${ownerScan === undefined ? "" : `Owner backfill: ${JSON.stringify(ownerScan.counts)}.\n`}${peopleScan === undefined ? "" : `Person links: ${JSON.stringify(peopleScan.counts)}.\n`}${tasksScan === undefined ? "" : `Tasks to notes: ${JSON.stringify(tasksScan.counts)}.\n`}`);
        return 0;
      }
      process.stderr.write(estimateText);
      const suggested = modelPass ? await bujo.proposeCurate(snapshot, input.curateLlm
        ?? await (await import("../../../composition/configured-memory.js")).createConfiguredCurationLlm(context.config, input.model), curateOptions)
        : { proposals: [], discarded: [] };
      const proposals: CurateProposal[] = [];
      const discarded: CurateDiscard[] = [...suggested.discarded];
      // Common case costs one canonical preview; bisect only a rejected group.
      // An invalid individual suggestion cannot discard the rest of a paid pass.
      const admit = (group: readonly CurateProposal[]): void => {
        if (group.length === 0) return;
        const candidates = [...proposals, ...group];
        try { bujo.previewCurateMutations(root, candidates, undefined, operatorMerges, ownersFor(candidates), peopleFor(candidates)); proposals.push(...group); }
        catch {
          if (group.length === 1) { discarded.push({ id: group[0]!.source.id, reason: "invalid-preview" }); return; }
          const middle = Math.floor(group.length / 2);
          admit(group.slice(0, middle)); admit(group.slice(middle));
        }
      };
      admit(suggested.proposals);
      if (tasksScan !== undefined) admit(tasksScan.proposals);
      const coarse = modelPass || tasksScan !== undefined ? undefined : bujo.proposeCoarseCurate(root, {
        select: input.curateSelect === "recent" ? "recent" : "oldest", fingerprint: snapshot.fingerprint });
      if (coarse !== undefined) { discarded.push(...coarse.discarded); admit(coarse.proposals); }
      const ownerAssociations = ownersFor(proposals);
      const ownerBackfill = ownerScan === undefined ? undefined : { ...ownerScan.counts, proposed: ownerAssociations.length,
        bare: ownerAssociations.filter(({ reason }) => reason === "owner-bare").length,
        supersededByDrop: scannedOwners.length - ownerAssociations.length };
      const personAssociations = peopleFor(proposals);
      const linkPeople = peopleScan === undefined ? undefined : { ...peopleScan.counts, proposed: personAssociations.length,
        supersededByDrop: scannedPeople.length - personAssociations.length };
      const createdAt = new Date().toISOString();
      const buildPlan = (): CuratePlan => {
        const payload = { schemaVersion: 1, operation: "curate", rootFingerprint: memoryRootFingerprint(root),
          sourceFingerprint: snapshot.fingerprint, model, createdAt, proposals, discarded,
          ...(operatorMerges.length === 0 ? {} : { operatorMerges }),
          ...(ownerScan === undefined ? {} : { ownerAssociations }),
          ...(peopleScan === undefined ? {} : { personAssociations }) } as const;
        return { ...payload, planDigest: curatePlanDigest(payload) };
      };
      // The whole plan, as written, must fit the private plan cap. A coarse
      // pass sheds its newest-selected labels (a later pass picks them up);
      // anything else fails before writing.
      const planBytes = (value: CuratePlan): number => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      let plan = buildPlan();
      let size = planBytes(plan);
      let coarseMore = coarse?.truncated === true;
      while (size > MAX_CURATE_PLAN_BYTES && coarse !== undefined && proposals.length > 0) {
        proposals.splice(Math.max(0, Math.floor(proposals.length * MAX_CURATE_PLAN_BYTES / size) - 1));
        coarseMore = true;
        plan = buildPlan(); size = planBytes(plan);
      }
      if (size > MAX_CURATE_PLAN_BYTES) throw new Error("curate plan exceeds private plan bound; use a smaller --limit");
      await writePrivateJsonExclusive(planPath, plan, MAX_CURATE_PLAN_BYTES);
      const discardedByReason = Object.fromEntries([...new Set(discarded.map(({ reason }) => reason))].map((reason) => [reason,
        discarded.filter((item) => item.reason === reason).length]));
      write(input.json, { operation: "curate-prepare", status: "prepared", planPath, count: proposals.length,
        operatorMerges: operatorMerges.length, ...(ownerBackfill === undefined ? {} : { ownerBackfill }),
        ...(linkPeople === undefined ? {} : { linkPeople }),
        ...(coarse === undefined ? {} : { coarseLabels: { more: coarseMore } }),
        ...(tasksScan === undefined ? {} : { tasksToNotes: tasksScan.counts }),
        discarded: discarded.length, discardedByReason, skipped: snapshot.skipped, selected: modelPass ? snapshot.selected : {} },
        () => `Curate plan prepared: ${proposals.length} proposals, ${operatorMerges.length} operator merges, ${ownerBackfill === undefined ? "" : `${ownerAssociations.length} owner associations (${JSON.stringify(ownerBackfill)}), `}${linkPeople === undefined ? "" : `${personAssociations.length} person links (${JSON.stringify(linkPeople)}), `}${discarded.length} discarded (${JSON.stringify(discardedByReason)}); skipped canonical lines: ${JSON.stringify(snapshot.skipped)} at ${planPath}. Review before applying.${coarseMore ? " More unlabelled person lines remain: apply this plan, then prepare again." : ""}${linkPeople?.more === true ? " More person links remain: apply this plan, then prepare again." : ""}\n`);
      return 0;
    }
    if (operation === "review" || operation === "apply") {
      const planPath = resolve(context.cwd, input.planPath!);
      const safePath = await canonicalProspectivePath(planPath);
      if (isSameOrUnderDirectory(root, safePath)) throw new Error("plan cannot be inside memory root");
      let plan = parseCuratePlan(await readPrivateJson(planPath, MAX_CURATE_PLAN_BYTES));
      for (const item of plan.proposals) bujo.validateCurateProposal(item);
      for (const merge of plan.operatorMerges ?? []) bujo.validateCurateOperatorMerge(merge);
      for (const association of plan.ownerAssociations ?? []) bujo.validateCurateOwnerAssociation(association);
      for (const association of plan.personAssociations ?? []) bujo.validateCuratePersonAssociation(association);
      if (plan.rootFingerprint !== memoryRootFingerprint(root)) throw new Error("plan belongs to another root");
      const replacePlan = async (updated: CuratePlan): Promise<void> => {
        const temp = `${planPath}.${process.pid.toString(36)}.tmp`;
        await writePrivateJsonExclusive(temp, updated, MAX_CURATE_PLAN_BYTES);
        try { await rename(temp, planPath); }
        catch (error) { await unlink(temp).catch(() => {}); throw error; }
        await fsyncParentDirectory(planPath);
      };
      if (operation === "review") {
        // Review keeps the plan applicable: an accepted drop wins over an owner link for the same line.
        const consistent = withAcceptedDropsWinning(plan);
        if (consistent !== plan) { await replacePlan(consistent); plan = consistent; }
      }
      if (operation === "review" && ((input.curateMerges?.length ?? 0) > 0 || input.curateMergeFile !== undefined)) {
        // Operator merges join the private plan as pre-accepted decisions; the
        // same apply-time validation still guards them.
        const added = await readCurateOperatorMerges(context, input, bujo);
        const existing = plan.operatorMerges ?? [];
        const merged = [...existing.filter((merge) => !added.some((next) => next.from === merge.from)), ...added];
        bujo.previewCurateMutations(root, plan.proposals.filter(({ accepted }) => accepted), undefined, merged, plan.ownerAssociations,
          plan.personAssociations);
        const { planDigest: _digest, ...payload } = { ...plan, operatorMerges: merged };
        await replacePlan({ ...payload, planDigest: curatePlanDigest(payload) });
        const { curateMerges: _merges, curateMergeFile: _file, allowCrossType: _cross, ...remainder } = input;
        return await runMemoryCurate(context, rest, remainder);
      }
      if (operation === "review") {
        const accept = input.curateAccept?.split(",") ?? [];
        const reject = input.curateReject?.split(",") ?? [];
        const selectors = [...accept, ...reject];
        if (selectors.some((selector) => !/^(keep|drop|rewrite|label|merge|retype|associate):(?:\*|[a-z][a-z-]{0,40})$|^id:[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(selector))
          || new Set(selectors).size !== selectors.length) throw new Error("invalid or duplicate review selector");
        const matches = (selector: string, proposal: CurateProposal) => selector === `id:${proposal.source.id}`
          || selector === `${proposal.action}:*` || selector === `${proposal.action}:${proposal.reason ?? "none"}`;
        // Operator merges are selected as `merge:operator`, `merge:*` or `id:<fromId>`.
        const matchesMerge = (selector: string, merge: CurateOperatorMerge) => selector === `id:${merge.from}`
          || selector === "merge:*" || selector === "merge:operator";
        const merges = plan.operatorMerges ?? [];
        // Owner associations are selected as `associate:owner` (text/label evidence),
        // `associate:owner-bare` (bare "User ..." lines, opt-in), `associate:*` or `id:<memoryId>`.
        const ownerCategory = (association: CurateOwnerAssociation) => association.reason === "owner-bare" ? "owner-bare" : "owner";
        const matchesOwner = (selector: string, association: CurateOwnerAssociation) => selector === `id:${association.id}`
          || selector === "associate:*" || selector === `associate:${ownerCategory(association)}`;
        const owners = plan.ownerAssociations ?? [];
        // Person links are selected as `associate:person-name`, `associate:*`
        // or `id:<memoryId>` (every link of that line).
        const matchesPerson = (selector: string, association: CuratePersonAssociation) => selector === `id:${association.id}`
          || selector === "associate:*" || selector === `associate:${association.reason}`;
        const people = plan.personAssociations ?? [];
        if (selectors.some((selector) => !plan.proposals.some((proposal) => matches(selector, proposal))
          && !merges.some((merge) => matchesMerge(selector, merge))
          && !owners.some((association) => matchesOwner(selector, association))
          && !people.some((association) => matchesPerson(selector, association)))) throw new Error("review selector matched no proposals");
        if (selectors.length > 0) {
          const decide = <T extends { readonly accepted: boolean }>(item: T, test: (selector: string, item: T) => boolean): T => ({ ...item,
            accepted: reject.some((selector) => test(selector, item)) ? false
              : accept.some((selector) => test(selector, item)) ? true : item.accepted });
          const updated = withAcceptedDropsWinning({ ...plan, proposals: plan.proposals.map((proposal) => decide(proposal, matches)),
            ...(plan.operatorMerges === undefined ? {} : { operatorMerges: plan.operatorMerges.map((merge) => decide(merge, matchesMerge)) }),
            ...(plan.ownerAssociations === undefined ? {} : { ownerAssociations: plan.ownerAssociations.map((association) => decide(association, matchesOwner)) }),
            ...(plan.personAssociations === undefined ? {} : { personAssociations: plan.personAssociations.map((association) => decide(association, matchesPerson)) }) });
          await replacePlan(updated);
          const { curateAccept: _accept, curateReject: _reject, ...remainder } = input;
          return await runMemoryCurate(context, rest, remainder);
        }
        const counts: Record<string, { total: number; accepted: number }> = {};
        for (const item of [...plan.proposals, ...merges.map((merge) => ({ action: "merge", reason: "operator", accepted: merge.accepted })),
          ...owners.map((association) => ({ action: "associate", reason: ownerCategory(association), accepted: association.accepted })),
          ...people.map(({ reason, accepted }) => ({ action: "associate", reason, accepted }))]) {
          const key = `${item.action}:${item.reason ?? "none"}`;
          const count = counts[key] ?? { total: 0, accepted: 0 };
          count.total++;
          if (item.accepted) count.accepted++;
          counts[key] = count;
        }
        // Owner links held back because the same line's drop is accepted.
        const droppedIds = curateDropIds(plan.proposals, true);
        const ownerSupersededByDrop = owners.filter(({ id }) => droppedIds.has(id)).length;
        const personSupersededByDrop = people.filter(({ id }) => droppedIds.has(id)).length;
        write(input.json, { operation: "curate-review", counts, discarded: plan.discarded,
          operatorMerges: merges.map(({ from, to, allowCrossType, accepted }) => ({ from, to, allowCrossType, accepted })).slice(0, 50),
          ...(plan.ownerAssociations === undefined ? {} : { ownerAssociations: owners.map(({ id, reason, accepted }) => ({ id, reason, accepted })).slice(0, 50),
            ownerSupersededByDrop }),
          ...(plan.personAssociations === undefined ? {} : { personAssociations: people.map(({ id, entityId, reason, accepted }) => ({ id, entityId, reason, accepted })).slice(0, 50),
            personSupersededByDrop }),
          examples: plan.proposals.slice(0, 5).map(({ source, action, reason, accepted }) => ({ id: source.id, action, reason, accepted })) },
          () => `Curate review: ${JSON.stringify(counts)}\nDiscarded suggestions (${plan.discarded.length}): ${JSON.stringify(plan.discarded.slice(0, 20))}${plan.discarded.length > 20 ? " (more in private plan)" : ""}\nExamples: ${JSON.stringify(plan.proposals.slice(0, 5).map(({ source, action, reason, accepted }) => ({ id: source.id, action, reason, accepted })))}${merges.length === 0 ? "" : `\nOperator merges (${merges.length}): ${merges.slice(0, 20).map(({ from, to, accepted }) => `${from} -> ${to}${accepted ? "" : " (rejected)"}`).join(", ")}${merges.length > 20 ? " (more in private plan)" : ""}`}${ownerSupersededByDrop === 0 ? "" : `\nOwner associations not accepted because the line is dropped: ${ownerSupersededByDrop}`}${personSupersededByDrop === 0 ? "" : `\nPerson links not accepted because the line is dropped: ${personSupersededByDrop}`}\nUse --accept drop:generic-advice,label:* or --reject id:<id>; review the private plan before applying.\n`);
        return 0;
      }
      // The package checks freshness under the writer lease. An interrupted root-swap
      // must be allowed through this CLI gate even when mutation changed the source:
      // only its matching durable transaction can restore the pre-apply tree.
      const operatorMerges = (plan.operatorMerges ?? []).filter(({ accepted }) => accepted);
      const ownerAssociations = (plan.ownerAssociations ?? []).filter(({ accepted }) => accepted);
      const personAssociations = (plan.personAssociations ?? []).filter(({ accepted }) => accepted);
      if (plan.proposals.every((item) => !item.accepted || item.action === "keep") && operatorMerges.length === 0 && ownerAssociations.length === 0
        && personAssociations.length === 0) {
        write(input.json, { operation: "curate-apply", status: "no-op" }, () => "No proposals accepted; memory unchanged.\n");
        return 0;
      }
      await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
      const settings = previewRecallSettings(context.config);
      if (settings?.embeddings === undefined) throw new Error("embeddings required");
      const selected = plan.proposals.filter((proposal) => proposal.accepted && proposal.action !== "keep");
      const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
      const embeddings = await createMemoryEmbeddingProvider(settings.embeddings);
      const result = await bujo.applyExplicitMemoryCurate({ root, proposals: selected,
        ...(operatorMerges.length === 0 ? {} : { operatorMerges }),
        ...(ownerAssociations.length === 0 ? {} : { ownerAssociations }),
        ...(personAssociations.length === 0 ? {} : { personAssociations }),
        expectedRootFingerprint: plan.rootFingerprint, expectedSourceFingerprint: plan.sourceFingerprint,
        planDigest: createHash("sha256").update(JSON.stringify({ planDigest: plan.planDigest, selected,
          ...(operatorMerges.length === 0 ? {} : { operatorMerges }),
          ...(ownerAssociations.length === 0 ? {} : { ownerAssociations }),
          ...(personAssociations.length === 0 ? {} : { personAssociations }) })).digest("hex"),
        embeddings, dimension: settings.embeddings.dim ?? 768 });
      write(input.json, { operation: "curate-apply", status: "applied", count: result.changed, backupPath: result.backupPath },
        () => `Curated ${result.changed} memory lines; restore backup: ${result.backupPath}.\n`);
      return 0;
    }
    await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
    const result = await bujo.restoreExplicitMemoryCurate({ root, backupPath: resolve(context.cwd, input.backupPath!),
      expectedRootFingerprint: memoryRootFingerprint(root) });
    write(input.json, { operation: "curate-restore", status: result.status, backupPath: result.backupPath },
      () => `Memory restored from ${result.backupPath}.\n`);
    return 0;
  } catch (error) {
    const status = error instanceof Error && error.name === "ExplicitMemoryCurateError" && "code" in error
      ? String(error.code) : operation === "prepare" ? "prepare_failed" : operation === "review" ? "review_failed"
        : operation === "restore" ? "restore_failed" : "apply_failed";
    const backupPath = error instanceof Error && "backupPath" in error && typeof error.backupPath === "string"
      ? error.backupPath : undefined;
    const messages: Readonly<Record<string, string>> = {
      apply_failed: "Curation was refused before a recoverable backup was available.",
      apply_failed_recovered: "Curation failed; the complete pre-apply backup was restored.",
      apply_recovery_failed: "Curation recovery could not be verified; keep the agent stopped and restore the reported backup.",
      restore_failed: "Curation restore was refused; the current store was not intentionally overwritten.",
      prepare_failed: "Curation preparation failed without changing the memory store.",
      review_failed: "Curation review failed without changing the memory store.",
    };
    const code = Object.hasOwn(messages, status) ? status : "apply_failed";
    // Only literal tool-owned diagnostics are safe to expose: a model/provider
    // error may impersonate the prefix and include private memory text.
    const safeCurateReasons = new Set([
      "memory-curate: invalid limit", "memory-curate: duplicate canonical id", "memory-curate: source changed",
      "memory-curate: invalid proposal", "memory-curate: unsupported retrospective label",
      "memory-curate: prompt exceeds bound", "memory-curate: response exceeds bound",
      "memory-curate: invalid response envelope", "memory-curate: ambiguous entity merge",
      "memory-curate: conflicting entity merge", "memory-curate: merge creates self-relation",
      "memory-curate: duplicate or missing source", "memory-curate: stale source line",
      "memory-curate: content-addressed Remember lines cannot be rewritten in place",
      "memory-curate: unsupported attribution rewrite", "memory-curate: unsupported date rewrite",
      "memory-curate: label refers to an unknown entity",
      "memory-curate: selected id is not in the active index",
      "memory-curate: invalid operator merge", "memory-curate: too many operator merges",
      "memory-curate: operator merge refers to an unknown entity",
      "memory-curate: cross-type merge requires --allow-cross-type",
      "memory-curate: merge invalidates a fact label",
      "memory-curate: invalid owner association", "memory-curate: too many owner associations",
      "memory-curate: conflicting owner association", "memory-curate: stale owner association",
      "memory-curate: owner association already exists", "memory-curate: rewrite invalidates owner association",
      "memory-curate: invalid person association", "memory-curate: too many person associations",
      "memory-curate: conflicting person association", "memory-curate: stale person association",
      "memory-curate: person association already exists", "memory-curate: rewrite invalidates person association",
      "memory-curate: association refers to an unknown entity",
      "memory-forget: canonical source changed after the plan was prepared.",
      "memory-forget: ids must be a non-empty set without duplicates.",
    ]);
    const safeReason = (value: unknown): string | undefined => {
      if (!(value instanceof Error)) return undefined;
      if (safeCurateReasons.has(value.message)) return value.message;
      if (value.message === "root mismatch") return "memory-curate: configured root changed since preparation";
      // Forget owns these diagnostics, but ids are omitted from public output.
      if (/^memory-forget: unknown memory id [A-Za-z0-9][A-Za-z0-9:._-]{0,127}\.$/u.test(value.message)) return "memory-forget: unknown memory id";
      if (/^memory-forget: memory [A-Za-z0-9][A-Za-z0-9:._-]{0,127} (?:requires exactly one canonical source bullet|is already terminal)\.$/u.test(value.message)) {
        return value.message.endsWith("is already terminal.") ? "memory-forget: memory is already terminal" : "memory-forget: memory requires exactly one canonical source bullet";
      }
      return undefined;
    };
    const reason = safeReason(error) ?? (error instanceof Error && error.name === "ExplicitMemoryCurateError"
      ? safeReason(error.cause) : undefined);
    const planExists = operation === "prepare" && error instanceof Error &&
      (error.message.startsWith("curate plan already exists at ") || ("code" in error && error.code === "EEXIST"));
    const detail = planExists ? `Plan already exists at ${resolve(context.cwd, input.planPath!)}; choose a new --plan path.`
      : reason ?? (code === "apply_failed_recovered" ? curateRecoveredFailureReason(error) : undefined);
    const restored = code === "apply_failed_recovered";
    write(input.json, { operation: `curate-${operation ?? "unknown"}`, status: "failed", code: `curate_${code}`,
      ...(detail === undefined ? {} : { reason: detail }),
      ...(operation === "apply" ? { restored } : {}), ...(backupPath === undefined ? {} : { backupPath }) },
      () => `${messages[code]}${detail === undefined ? "" : ` ${detail}`}${backupPath === undefined ? "" : ` Backup: ${backupPath}.`}\n`);
    return 1;
  }
}
