import type { Dirent, Stats } from "node:fs";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  isReadSkillCompatibleName,
  loadSkillIndexFromDirectory,
  type SkillIndexEntry,
} from "@mono-agent/agent-harness";
import type {
  TuiSkillInfo,
  TuiSkillRegistry,
  TuiSkillUnavailableReason,
} from "@mono-agent/operator-adapter";

import { canonicalToolName } from "./modules/known-tools.js";

export const SKILL_REGISTRY_REFRESH_MS = 5_000;
export const MAX_SKILL_REGISTRY_ITEMS = 256;
export const MAX_SKILL_DESCRIPTION_BYTES = 256;
export const MAX_SKILL_REGISTRY_BYTES = 256 * 1024;

type SkillIndexLoader = (root: string) => Promise<readonly SkillIndexEntry[]>;
type SkillRegistrySignatureReader = (root: string) => Promise<string>;

export interface SkillRegistryLogger {
  warn?(message: string, metadata?: Record<string, unknown>): void;
}

export interface CreateSkillRegistryMonitorOptions {
  readonly skillsRoot?: string;
  readonly selectedSkills: readonly string[];
  readonly skillDisclosure?: "index" | "full";
  readonly disallowedTools: readonly string[];
  readonly logger?: SkillRegistryLogger;
  /** Test seam for observing authoritative loader calls. */
  readonly loadIndex?: SkillIndexLoader;
  /** Test seam for deterministic filesystem invalidation. */
  readonly readSignature?: SkillRegistrySignatureReader;
  readonly refreshMs?: number;
}

export interface SkillRegistryMonitor {
  /** Loads the first knowable snapshot before the operator server is exposed. */
  prime(): Promise<void>;
  /** Returns the latest atomic snapshot without doing filesystem work. */
  snapshot(): TuiSkillRegistry;
  /** Revalidates immediately; duplicate calls share one in-flight refresh. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function isReadSkillDenied(disallowedTools: readonly string[]): boolean {
  return disallowedTools
    .map(canonicalToolName)
    .some((tool) => tool === "ReadSkill" || tool === "read_skill");
}

export function createSkillRegistryMonitor(
  options: CreateSkillRegistryMonitorOptions,
): SkillRegistryMonitor {
  const loadIndex = options.loadIndex ?? loadSkillIndexFromDirectory;
  const readSignature = options.readSignature ?? readSkillRegistrySignature;
  const refreshMs = options.refreshMs ?? SKILL_REGISTRY_REFRESH_MS;
  let current: TuiSkillRegistry = { status: "error", items: [] };
  let signature: string | undefined;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refreshOnce = async (force: boolean): Promise<void> => {
    if (options.skillsRoot === undefined) {
      current = { status: "ready", items: [], total: 0 };
      signature = "no-skills-root";
      return;
    }

    try {
      const nextSignature = await readSignature(options.skillsRoot);
      if (!force && signature === nextSignature) return;
      const entries = await loadIndex(options.skillsRoot);
      current = buildSkillRegistry(entries, {
        selectedSkills: options.selectedSkills,
        ...(options.skillDisclosure === undefined
          ? {}
          : { skillDisclosure: options.skillDisclosure }),
        readSkillDenied: isReadSkillDenied(options.disallowedTools),
      });
      signature = nextSignature;
    } catch (error) {
      // Do not retain a signature for a failed load: the next interval retries
      // even when a transient read error did not change filesystem metadata.
      signature = undefined;
      current = { status: "error", items: [] };
      options.logger?.warn?.("Skill registry refresh failed.", { error: errorMessage(error) });
    }
  };

  const refresh = (force = false): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = refreshOnce(force).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async prime() {
      await refresh(true);
    },
    snapshot() {
      return current;
    },
    refresh() {
      return refresh(false);
    },
    start() {
      if (options.skillsRoot === undefined || timer !== undefined) return;
      timer = setInterval(() => {
        void refresh(false);
      }, refreshMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

export function buildSkillRegistry(
  entries: readonly SkillIndexEntry[],
  options: {
    readonly selectedSkills: readonly string[];
    readonly skillDisclosure?: "index" | "full";
    readonly readSkillDenied: boolean;
  },
): TuiSkillRegistry {
  const selected = new Set(options.selectedSkills.map((name) => name.toLowerCase()));
  const classified = entries
    .map((entry) => classifySkill(entry, selected, options.skillDisclosure, options.readSkillDenied))
    .sort(compareSkillInfo);
  const items = boundSkillItems(classified);
  return {
    status: "ready",
    items,
    total: classified.length,
    ...(items.length < classified.length ? { truncated: true } : {}),
  };
}

function classifySkill(
  entry: SkillIndexEntry,
  selected: ReadonlySet<string>,
  skillDisclosure: "index" | "full" | undefined,
  readSkillDenied: boolean,
): TuiSkillInfo {
  const description = clampUtf8(entry.description, MAX_SKILL_DESCRIPTION_BYTES);
  if (!isReadSkillCompatibleName(entry.name)) {
    return unavailableSkill(entry.name, description, "unsupported-name");
  }
  if (selected.has(entry.name.toLowerCase())) {
    return {
      name: entry.name,
      description,
      availability: "inlined",
      reference: `$${entry.name}`,
    };
  }
  if ((skillDisclosure ?? "full") === "index" && !readSkillDenied) {
    return {
      name: entry.name,
      description,
      availability: "on-demand",
      reference: `$${entry.name}`,
    };
  }
  return unavailableSkill(
    entry.name,
    description,
    readSkillDenied && (skillDisclosure ?? "full") === "index"
      ? "read-skill-disabled"
      : "not-selected",
  );
}

function unavailableSkill(
  name: string,
  description: string,
  unavailableReason: TuiSkillUnavailableReason,
): TuiSkillInfo {
  return { name, description, availability: "unavailable", unavailableReason };
}

function compareSkillInfo(left: TuiSkillInfo, right: TuiSkillInfo): number {
  const availability = availabilityRank(left) - availabilityRank(right);
  if (availability !== 0) return availability;
  const leftKey = left.name.toLowerCase();
  const rightKey = right.name.toLowerCase();
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function availabilityRank(item: TuiSkillInfo): number {
  if (item.availability === "inlined") return 0;
  if (item.availability === "on-demand") return 1;
  return 2;
}

function boundSkillItems(items: readonly TuiSkillInfo[]): readonly TuiSkillInfo[] {
  const bounded: TuiSkillInfo[] = [];
  const total = items.length;
  const prefixBytes = Buffer.byteLength('{"status":"ready","items":[', "utf8");
  const suffixBytes = Buffer.byteLength(`],"total":${String(total)},"truncated":true}`, "utf8");
  let bytes = prefixBytes + suffixBytes;

  for (const item of items) {
    if (bounded.length >= MAX_SKILL_REGISTRY_ITEMS) break;
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (bounded.length === 0 ? 0 : 1);
    if (bytes + itemBytes > MAX_SKILL_REGISTRY_BYTES) break;
    bounded.push(item);
    bytes += itemBytes;
  }
  return bounded;
}

function clampUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let result = "";
  let used = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (used + width + suffixBytes > maxBytes) break;
    result += character;
    used += width;
  }
  return `${result}${suffix}`;
}

export async function readSkillRegistrySignature(
  skillsRoot: string,
  dependencies: {
    readonly readdir?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
    readonly stat?: (path: string) => Promise<Stats>;
  } = {},
): Promise<string> {
  const root = resolve(skillsRoot);
  const readDirectory = dependencies.readdir ?? fsReaddir;
  const stat = dependencies.stat ?? fsStat;
  const children = (await readDirectory(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files: Array<readonly [string, number, number]> = [];
  for (const child of children) {
    try {
      const metadata = await stat(join(root, child, "SKILL.md"));
      files.push([child, metadata.mtimeMs, metadata.size]);
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) continue;
      throw error;
    }
  }
  return JSON.stringify(files);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
