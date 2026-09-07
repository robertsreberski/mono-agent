import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { loadAppCoreConfig } from "./app-config.js";
import { createConfiguredAgentResponderForApp } from "./configured-agent.js";
import { loadProcessJobsSettings } from "./process-jobs-config.js";
import { hasExactProcessJobStateMarkers } from "./process-jobs-store.js";

type DisposableResponder = AgentResponder & { dispose?(): Promise<void> };

export interface LocalTuiSession {
  readonly responder: AgentResponder;
  readonly title: string;
  dispose(): Promise<void>;
}

export interface CreateLocalTuiSessionOptions {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
}

/** Build a current-folder responder for ordinary embedded chat only. */
export async function createLocalTuiSession(
  options: CreateLocalTuiSessionOptions,
): Promise<LocalTuiSession> {
  const authenticated = await authenticatedLocalConfig(options.cwd, options.configPath);
  const secureOptions = { ...options, ...authenticated };
  const config = await loadAppCoreConfig(secureOptions);
  const processJobs = await loadProcessJobsSettings({
    cwd: secureOptions.cwd,
    configPath: secureOptions.configPath,
    env: secureOptions.env,
  });
  const bootstrapProcessJobsStateDir = processJobs.enabled
    || await hasExactProcessJobStateMarkers(secureOptions.cwd, processJobs.stateDir)
    ? processJobs.stateDir
    : undefined;
  const responder = await createConfiguredAgentResponderForApp({
    config,
    // The configured responder owns both clear-sessions and process-job root
    // protection. Use the authenticated root, never the ambient CLI cwd.
    cwd: secureOptions.cwd,
  }, {
    bootstrapProcessJobs: {
      settings: processJobs,
      ...(bootstrapProcessJobsStateDir === undefined ? {} : { stateDir: bootstrapProcessJobsStateDir }),
    },
  }) as DisposableResponder;
  return {
    responder,
    title: config.agent?.name ?? "Mono Agent",
    async dispose(): Promise<void> {
      await responder.dispose?.();
    },
  };
}

async function authenticatedLocalConfig(
  cwd: string,
  configPath: string,
): Promise<{ readonly cwd: string; readonly configPath: string }> {
  const lexicalCwd = resolve(cwd);
  const lexicalConfig = resolve(configPath);
  assertLexicalPathInside(lexicalCwd, lexicalConfig, "Config path");
  const canonicalCwd = await realpath(lexicalCwd);
  await assertOwnedDirectory(canonicalCwd, "Current agent folder");
  const relativeConfig = relative(lexicalCwd, lexicalConfig);
  const canonicalConfig = await resolveOwnedRegularFileInside(
    canonicalCwd,
    resolve(canonicalCwd, relativeConfig),
    "Config file",
  );
  return { cwd: canonicalCwd, configPath: canonicalConfig };
}

async function resolveOwnedRegularFileInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the current agent folder.`);

  let parent = canonicalRoot;
  await assertOwnedDirectory(parent, "Current agent folder");
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    await assertOwnedDirectory(parent, `${label} parent`);
  }
  const target = join(parent, segments.at(-1)!);
  const info = await lstat(target);
  assertOwnedRegularFileInfo(info, target, label);
  const canonicalTarget = await realpath(target);
  assertLexicalPathInside(canonicalRoot, canonicalTarget, label);
  if (canonicalTarget !== target) {
    throw new Error(`${label} must not traverse a symbolic-link parent: ${path}`);
  }
  return target;
}

async function assertOwnedDirectory(path: string, label: string): Promise<void> {
  assertOwnedDirectoryInfo(await lstat(path), path, label);
}

function assertOwnedDirectoryInfo(info: Stats, path: string, label: string): void {
  if (!info.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function assertOwnedRegularFileInfo(info: Stats, path: string, label: string): void {
  if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} must be one regular file with one link: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function assertLexicalPathInside(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`))) {
    throw new Error(`${label} must stay inside the current agent folder: ${path}`);
  }
}
