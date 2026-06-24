import process from "node:process";

import {
  loadRepoVisibleDenylist,
  RepoVisibleGuardError,
  scanGitHubRepoMetadata,
  scanLocalRepoFiles,
} from "@mono-agent/repo-guard";
import type { RepoVisibleFinding, RepoVisibleScanSource } from "@mono-agent/repo-guard";

import * as ui from "./ui.js";

export interface RepoGuardCliArgs {
  readonly positionals: readonly string[];
  readonly local?: boolean;
  readonly github?: boolean;
  readonly includeUntracked?: boolean;
  readonly repo?: string;
  readonly denylistFile?: string;
  readonly json?: boolean;
}

interface RepoGuardReport {
  readonly denylistEntries: number;
  readonly warnings: readonly string[];
  readonly sources: readonly RepoVisibleScanSource[];
  readonly findings: readonly RepoVisibleFinding[];
}

export async function runRepoGuard(args: RepoGuardCliArgs): Promise<number> {
  const [action, ...extra] = args.positionals;
  if (action !== "scan" || extra.length > 0) {
    process.stderr.write(ui.errorLine("Usage: mono-agent repo-guard scan [--local] [--github --repo owner/name] [--include-untracked] [--denylist-file <path>] [--json]"));
    return 2;
  }

  let denylist;
  try {
    denylist = await loadRepoVisibleDenylist({
      env: process.env,
      cwd: process.cwd(),
      ...(args.denylistFile === undefined ? {} : { filePath: args.denylistFile }),
    });
  } catch (error) {
    process.stderr.write(`${formatRepoGuardError(error)}\n`);
    return 1;
  }

  const scanLocal = args.local === true || args.github !== true;
  const scanGithub = args.github === true;
  const findings: RepoVisibleFinding[] = [];
  const sources: RepoVisibleScanSource[] = [];

  if (scanLocal) {
    try {
      const result = await scanLocalRepoFiles({
        denylist,
        includeUntracked: args.includeUntracked === true,
      });
      findings.push(...result.findings);
      sources.push(...result.sources);
    } catch (error) {
      process.stderr.write(`${formatRepoGuardError(error)}\n`);
      return 1;
    }
  }

  if (scanGithub) {
    if (args.repo === undefined) {
      process.stderr.write(ui.errorLine("--repo owner/name is required with --github."));
      return 2;
    }
    try {
      const result = await scanGitHubRepoMetadata({ repo: args.repo, denylist });
      findings.push(...result.findings);
      sources.push(...result.sources);
    } catch (error) {
      process.stderr.write(`${formatRepoGuardError(error)}\n`);
      return 1;
    }
  }

  const report: RepoGuardReport = {
    denylistEntries: denylist.entries.length,
    warnings: denylist.warnings,
    sources,
    findings,
  };

  process.stdout.write(args.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderRepoGuardReport(report));
  return findings.length > 0 ? 1 : 0;
}

export function renderRepoGuardReport(report: RepoGuardReport): string {
  let out = "Repo-visible guard scan\n";
  out += `Denylist entries: ${report.denylistEntries}\n`;
  for (const source of report.sources) {
    out += `${source.kind}: ${source.scanned} scanned, ${source.skipped} skipped\n`;
  }
  for (const warning of report.warnings) {
    out += `Warning: ${warning}\n`;
  }
  for (const source of report.sources) {
    for (const warning of source.warnings) {
      out += `Warning: ${warning}\n`;
    }
  }

  if (report.findings.length === 0) {
    out += "Findings: none\n";
    return out;
  }

  out += `Findings: ${report.findings.length}\n`;
  for (const finding of report.findings) {
    const identifier = finding.identifier === undefined ? "" : ` ${finding.identifier}`;
    const location = finding.line === undefined ? "" : `:${finding.line}:${finding.column ?? 1}`;
    out += `  ${finding.surface}${identifier} ${finding.fieldPath}${location} label=${finding.label} match=${finding.matchKind}\n`;
  }
  return out;
}

function formatRepoGuardError(error: unknown): string {
  if (error instanceof RepoVisibleGuardError) {
    return `${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
