import * as ui from "../ui.js";
import {
  memoryImportOperationLabel,
  runMemoryBundleExport,
  runMemoryBundleImport,
  writeMemoryBundleFailure,
} from "./memory/bundle.js";
import { loadMemoryCommandContext } from "./memory/context.js";
import { runMemoryCurate } from "./memory/curate.js";
import { runMemoryForget } from "./memory/forget.js";
import { writeMemoryForgetFailure } from "./memory/forget-failure.js";
import {
  notConfiguredHealthReport,
  runAudit,
  runIndexTransition,
  runIntakeInspect,
  runIntakeMutation,
  runStrictAudit,
  strictHealthExitCode,
} from "./memory/health-intake.js";
import {
  DATE_RE,
  runEntityDuplicates,
  runLabelInventory,
  runLessonProposal,
  runProfileShow,
  runSearch,
  runShow,
  runStats,
  runTop,
  todayKey,
} from "./memory/read.js";
import { renderStrictAudit, write, writeNoMemory } from "./memory/render.js";
import { runReplayAdoption } from "./memory/replay-adoption.js";
import { writeReplayAdoptionCliFailure } from "./memory/replay-failure.js";
import { INTAKE_REASON_RE } from "./memory/types.js";
import type { RunMemoryCommandInput } from "./memory/types.js";
const INTAKE_ID_RE = /^[a-f0-9]{64}$/u;

export async function runMemoryCommand(input: RunMemoryCommandInput): Promise<number> {
  const usageError = memoryCommandUsageError(input);
  if (usageError !== undefined) {
    if (input.positionals[0] === "profile") {
      write(input.json, { code: "memory_profile_usage" }, () => "memory_profile_usage\n");
      return 2;
    }
    if (input.positionals[0] === "adopt-replay") {
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_usage");
      return 2;
    }
    if (input.positionals[0] === "curate") {
      write(input.json, { operation: `curate-${input.positionals[1] ?? "unknown"}`, status: "failed", code: "curate_usage" },
        () => `${usageError}\n`);
      return 2;
    }
    if (input.positionals[0] === "forget") {
      writeMemoryForgetFailure(input.json, input.positionals[1] ?? "unknown", "forget_usage");
      return 2;
    }
    if (input.positionals[0] === "export") {
      writeMemoryBundleFailure(input.json, "export", "export_usage");
      return 2;
    }
    if (input.positionals[0] === "import") {
      writeMemoryBundleFailure(input.json, memoryImportOperationLabel(input.positionals[1]), "import_usage");
      return 2;
    }
    process.stderr.write(ui.errorLine(usageError));
    return 2;
  }
  const context = await loadMemoryCommandContext(input);
  if ("code" in context) {
    return context.code;
  }

  const [rawSubcommand, ...rest] = input.positionals;
  const subcommand = rawSubcommand ?? "stats";
  if (context.config.memory === undefined) {
    if (subcommand === "profile") {
      write(input.json, { code: "memory_profile_requires_bujo" }, () => "memory_profile_requires_bujo\n");
      return 1;
    }
    if (subcommand === "audit" && input.strict) {
      const result = notConfiguredHealthReport();
      write(input.json, result, () => renderStrictAudit(result));
      return strictHealthExitCode(result.status);
    }
    if (subcommand === "adopt-replay") {
      writeReplayAdoptionCliFailure(input.json, "replay_adoption_requires_bujo");
      return 1;
    }
    if (subcommand === "curate") {
      write(input.json, { operation: `curate-${rest[0] ?? "unknown"}`, status: "failed", code: "curate_requires_bujo" },
        () => "Memory curate requires a configured BuJo store.\n");
      return 1;
    }
    if (subcommand === "forget") {
      writeMemoryForgetFailure(input.json, rest[0] ?? "unknown", "forget_requires_bujo");
      return 1;
    }
    if (subcommand === "export" || subcommand === "import") {
      writeMemoryBundleFailure(
        input.json,
        subcommand === "export" ? "export" : memoryImportOperationLabel(rest[0]),
        subcommand === "export" ? "export_requires_bujo" : "import_requires_bujo",
      );
      return 1;
    }
    writeNoMemory(context.configPath, input.json);
    return 0;
  }

  switch (subcommand) {
    case "stats":
      return await runStats(context, input);
    case "today":
      return await runShow(context, todayKey(), input.json);
    case "show": {
      const date = rest[0];
      if (date === undefined || !DATE_RE.test(date)) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory show <YYYY-MM-DD>."));
        return 2;
      }
      return await runShow(context, date, input.json);
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory search <query>."));
        return 2;
      }
      return await runSearch(context, query, input);
    }
    case "top":
      return await runTop(context, input);
    case "profile":
      return await runProfileShow(context, input);
    case "labels":
      return await runLabelInventory(context, input);
    case "entities":
      return await runEntityDuplicates(context, input);
    case "lessons":
      return await runLessonProposal(context, input);
    case "audit":
      return input.strict
        ? await runStrictAudit(context, input.json)
        : await runAudit(context, input.json);
    case "inspect":
      return await runIntakeInspect(context, rest[0], input.json);
    case "retry":
      return await runIntakeMutation(context, "retry", rest[0], undefined, input.json);
    case "resolve":
      return await runIntakeMutation(context, "resolve", rest[0], rest[1], input.json);
    case "rebuild":
      return await runIndexTransition(context, "rebuild", input.json);
    case "rollback":
      return await runIndexTransition(context, "rollback", input.json);
    case "adopt-replay":
      return await runReplayAdoption(context, input.json);
    case "forget":
      return await runMemoryForget(context, rest, input);
    case "curate":
      return await runMemoryCurate(context, rest, input);
    case "export":
      return await runMemoryBundleExport(context, input);
    case "import":
      return await runMemoryBundleImport(context, rest, input);
    default:
      process.stderr.write(ui.errorLine(`Unknown memory subcommand \`${subcommand}\`.`));
      process.stderr.write(ui.hint("Expected stats, today, show <date>, search <query>, top, labels, profile show, entities --duplicates, lessons --propose, audit, inspect [id], retry [id], resolve <id> <reason>, rebuild, rollback, adopt-replay, forget prepare|apply|restore, export, or import prepare|apply|restore."));
      return 2;
  }
}

function memoryCommandUsageError(input: RunMemoryCommandInput): string | undefined {
  const [rawSubcommand, ...rest] = input.positionals;
  const subcommand = rawSubcommand ?? "stats";
  if ((input.labelKind !== undefined || input.labelAbout !== undefined || input.labelScope !== undefined) && subcommand !== "labels") {
    return "--kind, --about, and --scope require `mono-agent memory labels`.";
  }
  if (input.propose === true && subcommand !== "lessons") return "--propose requires `mono-agent memory lessons`.";
  if (input.strict && subcommand !== "audit") {
    return "--strict is only supported for `mono-agent memory audit`.";
  }
  if (input.limit !== undefined && subcommand !== "stats" && subcommand !== "search" && subcommand !== "top" && subcommand !== "entities" && subcommand !== "labels" && !(subcommand === "curate" && rest[0] === "prepare")) {
    return "--limit is only supported for memory stats, search, top, labels, entities, and curate prepare.";
  }
  if (input.curateSelect !== undefined && !(subcommand === "curate" && rest[0] === "prepare")) {
    return "--select requires `mono-agent memory curate prepare`.";
  }
  const operatorMerges = (input.curateMerges?.length ?? 0) > 0 || input.curateMergeFile !== undefined;
  if ((operatorMerges || input.allowCrossType === true) && !(subcommand === "curate" && (rest[0] === "prepare" || rest[0] === "review"))) {
    return "--merge, --merge-file and --allow-cross-type require `mono-agent memory curate prepare|review`.";
  }
  if (input.allowCrossType === true && !operatorMerges) return "--allow-cross-type requires --merge or --merge-file.";
  if (input.ownerBackfill === true && !(subcommand === "curate" && rest[0] === "prepare")) {
    return "--owner-backfill requires `mono-agent memory curate prepare`.";
  }
  if (input.linkPeople === true && !(subcommand === "curate" && rest[0] === "prepare" && input.limit === 0)) {
    return "--link-people requires `mono-agent memory curate prepare --limit 0`.";
  }
  if (input.semanticReview === true && (!(subcommand === "curate" && rest[0] === "prepare") || input.tasksToNotes === true || input.limit === 0)) {
    return "memory_semantic_review_requires_model_prepare";
  }
  if (input.tasksToNotes === true && !(subcommand === "curate" && rest[0] === "prepare")) {
    return "--tasks-to-notes requires `mono-agent memory curate prepare`.";
  }
  if ((input.tasksBefore !== undefined || input.captureOnly === true) && input.tasksToNotes !== true) {
    return "--before and --capture-only require `mono-agent memory curate prepare --tasks-to-notes`.";
  }
  if (input.tasksToNotes === true && (input.limit !== undefined || input.curateSelect !== undefined || input.ownerBackfill === true
    || input.linkPeople === true || (input.curateMerges?.length ?? 0) > 0 || input.curateMergeFile !== undefined)) {
    return "--tasks-to-notes is its own model-free pass; do not combine it with --limit, --select, --owner-backfill, --link-people or merges.";
  }
  if (input.limit === 0 && !(subcommand === "curate" && rest[0] === "prepare")) {
    return "--limit 0 is only supported for `mono-agent memory curate prepare`.";
  }
  if (input.limit === 0 && input.curateSelect !== undefined && input.curateSelect !== "oldest" && input.curateSelect !== "recent") {
    return "--limit 0 supports only --select oldest or --select recent.";
  }
  if (input.duplicates === true && subcommand !== "entities") return "--duplicates requires `mono-agent memory entities`.";
  switch (subcommand) {
    case "profile":
      return rest.length === 1 && rest[0] === "show" ? undefined : "memory_profile_usage";
    case "labels":
      return rest.length === 0 ? undefined : "Usage: mono-agent memory labels [--kind k] [--about entity] [--scope s] [--limit N] [--json].";
    case "entities":
      return rest.length === 0 && input.duplicates === true ? undefined : "Usage: mono-agent memory entities --duplicates [--limit N] [--json].";
    case "lessons":
      return rest.length === 0 && input.propose === true ? undefined : "Usage: mono-agent memory lessons --propose.";
    case "stats":
    case "today":
    case "top":
    case "audit":
    case "rebuild":
    case "rollback":
    case "adopt-replay":
      return rest.length === 0 ? undefined : `Usage: mono-agent memory ${subcommand}.`;
    case "show":
      return rest.length === 1 && DATE_RE.test(rest[0] ?? "")
        ? undefined
        : "Usage: mono-agent memory show <YYYY-MM-DD>.";
    case "search":
      return rest.join(" ").trim().length > 0
        ? undefined
        : "Usage: mono-agent memory search <query>.";
    case "inspect":
      return rest.length <= 1 && (rest[0] === undefined || INTAKE_ID_RE.test(rest[0]))
        ? undefined
        : "Usage: mono-agent memory inspect [<64-character-id>].";
    case "retry":
      return rest.length <= 1 && (rest[0] === undefined || INTAKE_ID_RE.test(rest[0]))
        ? undefined
        : "Usage: mono-agent memory retry [<64-character-id>].";
    case "resolve":
      if (rest.length !== 2 || !INTAKE_ID_RE.test(rest[0] ?? "")) {
        return "Usage: mono-agent memory resolve <64-character-id> <reason-slug>.";
      }
      return INTAKE_REASON_RE.test(rest[1] ?? "")
        ? undefined
        : "memory resolve reason must be a 1-64 character lowercase slug.";
    case "curate": {
      if (rest.length !== 1) return "Usage: mono-agent memory curate prepare|review|apply|restore.";
      if (rest[0] === "prepare") return input.planPath !== undefined && input.backupPath === undefined && input.curateAccept === undefined && input.curateReject === undefined
        ? undefined : "Usage: mono-agent memory curate prepare --plan file [--limit N] [--model provider:model] [--dry-run] [--merge from=to ...] [--merge-file file] [--allow-cross-type].";
      if (rest[0] === "review") return input.planPath !== undefined && input.backupPath === undefined && input.model === undefined && !input.dryRun
        ? undefined : "Usage: mono-agent memory curate review --plan file [--accept category,...] [--reject category,...] [--merge from=to ...] [--merge-file file] [--allow-cross-type].";
      if (rest[0] === "apply") return input.planPath !== undefined && input.backupPath === undefined && input.model === undefined && !input.dryRun
        ? undefined : "Usage: mono-agent memory curate apply --plan file.";
      if (rest[0] === "restore") return input.backupPath !== undefined && input.planPath === undefined && input.model === undefined && !input.dryRun
        ? undefined : "Usage: mono-agent memory curate restore --backup dir.";
      return "Usage: mono-agent memory curate prepare|review|apply|restore.";
    }
    case "forget": {
      const operation = rest[0];
      if (rest.length !== 1 || (operation !== "prepare" && operation !== "apply" && operation !== "restore")) {
        return "Usage: mono-agent memory forget prepare|apply|restore with the required operation flags.";
      }
      if (operation === "prepare") {
        return input.idsFile !== undefined && input.reason !== undefined && input.planPath !== undefined
          && input.backupPath === undefined && INTAKE_REASON_RE.test(input.reason)
          ? undefined
          : "Usage: mono-agent memory forget prepare --ids-file <file> --reason <lowercase-slug> --plan <file>.";
      }
      if (operation === "apply") {
        return input.planPath !== undefined && input.idsFile === undefined && input.reason === undefined
          && input.backupPath === undefined
          ? undefined
          : "Usage: mono-agent memory forget apply --plan <file>.";
      }
      return input.backupPath !== undefined && input.idsFile === undefined && input.reason === undefined
        && input.planPath === undefined
        ? undefined
        : "Usage: mono-agent memory forget restore --backup <dir>.";
    }
    case "export":
      if (rest.length !== 0 || input.bundlePath === undefined || input.planPath !== undefined
        || input.backupPath !== undefined || input.onConflict !== undefined
        || input.entityConflict !== undefined || input.acceptDerivedAssociationDrift === true) {
        return "Usage: mono-agent memory export --bundle <dir> [--include-extras] [--allow-pending].";
      }
      return undefined;
    case "import": {
      const operation = rest[0];
      if (rest.length !== 1 || (operation !== "prepare" && operation !== "apply" && operation !== "restore")) {
        return "Usage: mono-agent memory import prepare|apply|restore with the required operation flags.";
      }
      if (input.includeExtras === true || input.allowPending === true) {
        return "--include-extras and --allow-pending are only supported for `mono-agent memory export`.";
      }
      if (operation === "prepare") {
        return input.bundlePath !== undefined && input.planPath !== undefined && input.backupPath === undefined
          ? undefined
          : "Usage: mono-agent memory import prepare --bundle <dir> --plan <file> "
            + "[--on-conflict fail|skip] [--entity-conflict target|source] [--accept-derived-association-drift].";
      }
      if (operation === "apply") {
        return input.planPath !== undefined && input.bundlePath === undefined && input.backupPath === undefined
          && input.onConflict === undefined && input.entityConflict === undefined
          && input.acceptDerivedAssociationDrift !== true
          ? undefined
          : "Usage: mono-agent memory import apply --plan <file>.";
      }
      return input.backupPath !== undefined && input.bundlePath === undefined && input.planPath === undefined
        && input.onConflict === undefined && input.entityConflict === undefined
        && input.acceptDerivedAssociationDrift !== true
        ? undefined
        : "Usage: mono-agent memory import restore --backup <dir>.";
    }
    default:
      return undefined;
  }
}
