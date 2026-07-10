import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import {
  CONFIG_ENV_KEYS,
  readMonoAgentConfigJson,
  type MonoAgentConfig,
  type MonoAgentConfigJson,
} from "@mono-agent/config";
import type {
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
} from "@mono-agent/agent-harness";
import type { ConfigurationProposalCard, ConfigurationProposalResult } from "@mono-agent/tui";

import { loadAppCoreConfig } from "./app-config.js";
import { createConfiguredAgentResponder } from "./configured-agent.js";
import {
  CONFIGURATION_PROPOSAL_MCP_SERVER_NAME,
  configurationProposalMcpServerSpec,
  type AgentConfigurationProposal,
  type JsonPatchOperation,
} from "./configuration-proposal-tool.js";
import { validateMonoAgentFolder } from "./doctor.js";

export const LOCAL_CONFIGURATION_PROMPT =
  "Begin local configuration mode. Read the mono-agent-configure skill, then ask the operator one concise question: how would they like to configure you further? Mention that behavior, memory, skills, tools, or channels can be discussed, but do not repeat the setup wizard and do not ask for secrets.";

type DisposableResponder = AgentResponder & { dispose?(): Promise<void> };

interface PreparedProposal {
  readonly proposal: AgentConfigurationProposal;
  readonly candidate: MonoAgentConfigJson;
  readonly expectedConfigVersion: string;
  readonly configBefore: string;
  readonly rolePath?: string;
  readonly roleBefore?: string;
  readonly roleAfter?: string;
  readonly expectedRoleHash?: string;
  readonly card: ConfigurationProposalCard;
}

interface AppliedConfigurationChange {
  readonly changeId: string;
  readonly rollbackDir: string;
  rollback(): Promise<void>;
}

export interface LocalConfigurationSession {
  readonly responder: AgentResponder;
  readonly title: string;
  readonly configuration: {
    readonly initialPrompt?: string;
    readonly prompt: string;
    takeProposal(): Promise<ConfigurationProposalCard | undefined>;
    approve(id: string): Promise<ConfigurationProposalResult>;
    reject(id: string): Promise<ConfigurationProposalResult>;
  };
  dispose(): Promise<void>;
}

export interface CreateLocalConfigurationSessionOptions {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly configure: boolean;
}

/** Build a current-folder responder without starting channels or creating service state. */
export async function createLocalConfigurationSession(
  options: CreateLocalConfigurationSessionOptions,
): Promise<LocalConfigurationSession> {
  const manager = await LocalConfigurationManager.create(options);
  let active = await manager.buildResponder();
  const activateResponder = async (replacement: DisposableResponder): Promise<void> => {
    const previous = active;
    active = replacement;
    await previous.dispose?.();
  };
  const replaceActiveResponder = async (): Promise<void> => {
    const replacement = await manager.buildResponder();
    await activateResponder(replacement);
  };
  const proxy: AgentResponder = {
    respond: async (request, stream) => await active.respond(request, stream),
    cancel: (conversationId, reason) => active.cancel?.(conversationId, reason),
    deliverVerbatim: async (conversationId, text) => await active.deliverVerbatim?.(conversationId, text),
  };

  return {
    responder: proxy,
    title: manager.currentConfig.agent?.name ?? "Mono Agent",
    configuration: {
      ...(options.configure ? { initialPrompt: LOCAL_CONFIGURATION_PROMPT } : {}),
      prompt: LOCAL_CONFIGURATION_PROMPT,
      takeProposal: async () => {
        let proposal: ConfigurationProposalCard | undefined;
        try {
          proposal = await manager.takeProposal();
        } catch (error) {
          // A failed proposal must not leave its request-scoped MCP server in a
          // retained provider session. Rotate first, then report the validation
          // failure to the TUI.
          await replaceActiveResponder();
          throw error;
        }
        if (proposal === undefined) {
          // Codex and other resumable providers retain the MCP configuration
          // from the turn that opened their provider session. Rotating after a
          // proposal-free configuration turn makes the next reply start with a
          // fresh request-scoped server and removes the tool before ordinary
          // turns. The stable proxy keeps the TUI connection unchanged.
          await replaceActiveResponder();
        }
        return proposal;
      },
      approve: async (id) => {
        const applied = await manager.apply(id);
        let replacement: DisposableResponder;
        try {
          replacement = await manager.buildResponder();
        } catch (error) {
          await applied.rollback();
          throw new Error(
            `The approved files were restored because the replacement responder could not start: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await activateResponder(replacement);
        return {
          message: `Applied configuration change ${applied.changeId}. A fresh provider conversation is now active. Rollback evidence: ${applied.rollbackDir}`,
        };
      },
      reject: async (id) => {
        const result = await manager.reject(id);
        await replaceActiveResponder();
        return result;
      },
    },
    async dispose(): Promise<void> {
      await active.dispose?.();
      await manager.dispose();
    },
  };
}

export class LocalConfigurationManager {
  readonly currentConfig: MonoAgentConfig;
  private readonly pendingSinks = new Set<string>();
  private readonly prepared = new Map<string, PreparedProposal>();

  private constructor(
    private readonly options: CreateLocalConfigurationSessionOptions,
    private readonly sessionDir: string,
    currentConfig: MonoAgentConfig,
  ) {
    this.currentConfig = currentConfig;
  }

  static async create(options: CreateLocalConfigurationSessionOptions): Promise<LocalConfigurationManager> {
    const authenticated = await authenticatedLocalConfig(options.cwd, options.configPath);
    const secureOptions = {
      ...options,
      cwd: authenticated.cwd,
      configPath: authenticated.configPath,
    };
    const parent = await ensureOwnedDirectoryInside(
      secureOptions.cwd,
      join(secureOptions.cwd, ".mono-agent", "configuration-proposals"),
      "Configuration proposal directory",
    );
    const sessionDir = await mkdtemp(join(parent, "session-"));
    await chmod(sessionDir, 0o700);
    const currentConfig = await loadAppCoreConfig(secureOptions);
    return new LocalConfigurationManager(secureOptions, sessionDir, currentConfig);
  }

  async buildResponder(): Promise<DisposableResponder> {
    await resolveOwnedRegularFileInside(this.options.cwd, this.options.configPath, "Config file");
    const config = await loadAppCoreConfig(this.options);
    return await createConfiguredAgentResponder({
      config,
      runtimeOptionsForRequest: async (input) => await this.runtimeExtension(input),
    }) as DisposableResponder;
  }

  private async runtimeExtension(
    input: AgentHarnessRuntimeOptionsInput,
  ): Promise<AgentHarnessRuntimeOptionsExtension> {
    if (!isLocalConfigurationRequest(input.request.metadata)) {
      return { runtimeOptions: {} };
    }
    const secureConfig = await resolveOwnedRegularFileInside(this.options.cwd, this.options.configPath, "Config file");
    const snapshot = await readMonoAgentConfigJson(secureConfig);
    const sessionDir = await ensureOwnedDirectoryInside(
      this.options.cwd,
      this.sessionDir,
      "Configuration proposal session",
    );
    const sinkPath = join(sessionDir, `${safeFilePart(input.runId)}.json`);
    this.pendingSinks.add(sinkPath);
    return {
      runtimeOptions: {
        mcpServers: {
          [CONFIGURATION_PROPOSAL_MCP_SERVER_NAME]: configurationProposalMcpServerSpec({
            sinkPath,
            baseVersion: snapshot.version,
          }, this.options.cwd),
        },
      },
    };
  }

  async takeProposal(): Promise<ConfigurationProposalCard | undefined> {
    await ensureOwnedDirectoryInside(this.options.cwd, this.sessionDir, "Configuration proposal session");
    for (const sink of [...this.pendingSinks]) {
      this.pendingSinks.delete(sink);
      const contents = await readOptional(sink);
      await rm(sink, { force: true });
      if (contents === undefined) continue;
      const proposal = parseProposal(contents);
      return await this.prepareProposal(proposal);
    }
    return undefined;
  }

  async reject(id: string): Promise<ConfigurationProposalResult> {
    if (!this.prepared.delete(id)) {
      throw new Error(`Configuration proposal ${id} is no longer pending.`);
    }
    return { message: `Rejected configuration proposal ${id}; no files changed.` };
  }

  async prepareProposal(proposal: AgentConfigurationProposal): Promise<ConfigurationProposalCard> {
    const prepared = await this.prepare(proposal);
    this.prepared.set(proposal.id, prepared);
    return prepared.card;
  }

  private async prepare(proposal: AgentConfigurationProposal): Promise<PreparedProposal> {
    const secureConfig = await resolveOwnedRegularFileInside(this.options.cwd, this.options.configPath, "Config file");
    const current = await readMonoAgentConfigJson(secureConfig);
    if (proposal.baseVersion !== current.version) {
      throw new Error("Configuration changed while the agent was preparing its proposal. Run /configure again from the current config.");
    }
    assertProposalContainsNoSecrets(proposal, this.options.env);
    assertNoEnvironmentShadow(proposal.patch, this.options.env);

    const candidate = applyJsonPatch(current.json, proposal.patch);
    assertConversationalPatchAllowed(current.json, candidate);
    const configBefore = await readFile(secureConfig, "utf8");
    if (sha256(configBefore) !== current.version) {
      throw new Error("Configuration changed while the agent was preparing its proposal. Run /configure again from the current config.");
    }
    await this.validateCandidate(candidate, proposal.id);

    let rolePath: string | undefined;
    let roleBefore: string | undefined;
    let roleAfter: string | undefined;
    let expectedRoleHash: string | undefined;
    if (proposal.role !== undefined) {
      if (proposal.patch.some((operation) => pathsOverlap(operation.path, "/context/identityPath"))) {
        throw new Error("Change context.identityPath separately from a Role update so the host can verify one identity file at a time.");
      }
      const effective = await loadAppCoreConfig(this.options);
      rolePath = effective.context.identityPath;
      rolePath = await resolveOwnedRegularFileInside(this.options.cwd, rolePath, "Identity file");
      roleBefore = await readFile(rolePath, "utf8");
      expectedRoleHash = sha256(roleBefore);
      roleAfter = replaceRoleSection(roleBefore, proposal.role);
    }

    const details = proposal.patch.map(formatPatchOperation);
    if (proposal.role !== undefined) details.push("replace IDENTITY.md ## Role body");
    const card: ConfigurationProposalCard = {
      id: proposal.id,
      title: "Agent configuration proposal",
      rationale: proposal.rationale,
      details,
    };
    return {
      proposal,
      candidate,
      expectedConfigVersion: current.version,
      configBefore,
      ...(rolePath === undefined ? {} : { rolePath }),
      ...(roleBefore === undefined ? {} : { roleBefore }),
      ...(roleAfter === undefined ? {} : { roleAfter }),
      ...(expectedRoleHash === undefined ? {} : { expectedRoleHash }),
      card,
    };
  }

  async apply(id: string): Promise<AppliedConfigurationChange> {
    const prepared = this.prepared.get(id);
    if (prepared === undefined) throw new Error(`Configuration proposal ${id} is no longer pending.`);

    return await withConfigurationTransactionLock(this.options.cwd, id, async () =>
      await this.applyPrepared(id, prepared));
  }

  private async applyPrepared(id: string, prepared: PreparedProposal): Promise<AppliedConfigurationChange> {
    await assertPreparedSourcesCurrent(this.options.cwd, this.options.configPath, prepared, "after the proposal was shown");
    await this.validateCandidate(prepared.candidate, `${id}-approval`);

    const changeId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${id.slice(0, 8)}`;
    const rollbackRoot = await ensureOwnedDirectoryInside(
      this.options.cwd,
      join(this.options.cwd, ".mono-agent", "config-changes"),
      "Configuration rollback directory",
    );
    const rollbackDir = await ensureOwnedDirectoryInside(
      this.options.cwd,
      join(rollbackRoot, changeId),
      "Configuration change directory",
    );
    await writeFile(join(rollbackDir, "mono-agent.config.json.before"), prepared.configBefore, { flag: "wx", mode: 0o600 });
    if (prepared.roleBefore !== undefined) {
      await writeFile(join(rollbackDir, "IDENTITY.md.before"), prepared.roleBefore, { flag: "wx", mode: 0o600 });
    }

    const configAfter = `${JSON.stringify(prepared.candidate, null, 2)}\n`;
    let configWritten = false;
    let roleWritten = false;
    try {
      // Candidate validation and rollback-evidence staging both await I/O. A
      // second comparison at the actual commit boundary prevents either step
      // from opening a stale-snapshot overwrite window. The owner-only lock
      // serializes every mono-agent writer; the comparison also catches an
      // editor or other non-cooperating process.
      await assertPreparedSourcesCurrent(this.options.cwd, this.options.configPath, prepared, "while the approved change was being prepared");
      await atomicReplaceExact(this.options.cwd, this.options.configPath, prepared.configBefore, configAfter);
      configWritten = true;
      if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
        // Config and Role are two files, so re-check both sides after the first
        // rename and before the second. If either changed, the guarded catch
        // restores only files that still equal our exact committed bytes.
        await assertExactOwnedContents(this.options.cwd, this.options.configPath, configAfter, "Committed config changed before the Role update");
        await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleBefore!, "IDENTITY.md changed at the Role commit boundary");
        await atomicReplaceExact(this.options.cwd, prepared.rolePath, prepared.roleBefore!, prepared.roleAfter);
        roleWritten = true;
      }
      const verified = await readMonoAgentConfigJson(this.options.configPath);
      if (!isDeepStrictEqual(verified.json, prepared.candidate)) {
        throw new Error("The committed config did not verify byte-for-byte against the approved candidate.");
      }
      if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
        await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleAfter, "The committed Role did not verify");
      }
      await ensureOwnedDirectoryInside(this.options.cwd, rollbackDir, "Configuration change directory");
      await writeFile(join(rollbackDir, "change.json"), `${JSON.stringify({
        schema: "mono-agent.configuration-change.v1",
        changeId,
        proposalId: prepared.proposal.id,
        appliedAt: new Date().toISOString(),
        previousConfigVersion: prepared.expectedConfigVersion,
        configVersion: verified.version,
        changedPaths: prepared.proposal.patch.map((operation) => operation.path),
        roleChanged: prepared.roleAfter !== undefined,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const recoveryErrors: string[] = [];
      if (roleWritten && prepared.rolePath !== undefined && prepared.roleAfter !== undefined && prepared.roleBefore !== undefined) {
        try {
          await restoreIfExact(this.options.cwd, prepared.rolePath, prepared.roleAfter, prepared.roleBefore);
        } catch (restoreError) {
          recoveryErrors.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      }
      if (configWritten) {
        try {
          await restoreIfExact(this.options.cwd, this.options.configPath, configAfter, prepared.configBefore);
        } catch (restoreError) {
          recoveryErrors.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      } else if (!roleWritten) {
        await rm(rollbackDir, { recursive: true, force: true });
      }
      if (recoveryErrors.length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Manual recovery is required; concurrent edits were preserved. ` +
          `${recoveryErrors.join(" ")} Rollback evidence: ${rollbackDir}`,
        );
      }
      throw error;
    }

    this.prepared.delete(id);
    return {
      changeId,
      rollbackDir,
      rollback: async () => {
        await withConfigurationTransactionLock(this.options.cwd, `${id}-rollback`, async () => {
          await assertExactOwnedContents(this.options.cwd, this.options.configPath, configAfter, "Configuration changed before rollback");
          if (prepared.rolePath !== undefined && prepared.roleAfter !== undefined) {
            await assertExactOwnedContents(this.options.cwd, prepared.rolePath, prepared.roleAfter, "IDENTITY.md changed before rollback");
            await atomicReplaceExact(this.options.cwd, prepared.rolePath, prepared.roleAfter, prepared.roleBefore!);
          }
          await atomicReplaceExact(this.options.cwd, this.options.configPath, configAfter, prepared.configBefore);
          await ensureOwnedDirectoryInside(this.options.cwd, rollbackDir, "Configuration change directory");
          await writeFile(join(rollbackDir, "rollback.json"), `${JSON.stringify({
            schema: "mono-agent.configuration-rollback.v1",
            changeId,
            rolledBackAt: new Date().toISOString(),
          }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        });
      },
    };
  }

  private async validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void> {
    const sessionDir = await ensureOwnedDirectoryInside(
      this.options.cwd,
      this.sessionDir,
      "Configuration proposal session",
    );
    const path = join(sessionDir, `${safeFilePart(label)}.candidate.json`);
    await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    try {
      const report = await validateMonoAgentFolder({
        cwd: this.options.cwd,
        configPath: path,
        env: this.options.env,
        allowFilesystemWrites: false,
        liveness: false,
      });
      const errors = report.sections.filter((section) => section.status === "error");
      if (errors.length > 0) {
        throw new Error(
          `Proposed configuration does not validate: ${errors.map((section) => `${section.label}: ${section.details.join(" ")}`).join("; ")}`,
        );
      }
      await loadAppCoreConfig({ cwd: this.options.cwd, configPath: path, env: this.options.env });
    } finally {
      await rm(path, { force: true });
    }
  }

  async dispose(): Promise<void> {
    await rm(this.sessionDir, { recursive: true, force: true });
  }
}

export function isLocalConfigurationRequest(metadata: Record<string, unknown> | undefined): boolean {
  const tui = metadata?.tui;
  return typeof tui === "object" && tui !== null
    && (tui as Record<string, unknown>).local === true
    && (tui as Record<string, unknown>).configuration === true;
}

function parseProposal(contents: string): AgentConfigurationProposal {
  const parsed = JSON.parse(contents) as Partial<AgentConfigurationProposal>;
  if (
    parsed.schema !== "mono-agent.configuration-proposal.v1"
    || typeof parsed.id !== "string"
    || typeof parsed.baseVersion !== "string"
    || typeof parsed.rationale !== "string"
    || !Array.isArray(parsed.patch)
    || typeof parsed.createdAt !== "string"
  ) {
    throw new Error("The configuration proposal payload was malformed.");
  }
  return parsed as AgentConfigurationProposal;
}

export function applyJsonPatch(
  input: MonoAgentConfigJson,
  operations: readonly JsonPatchOperation[],
): MonoAgentConfigJson {
  const root = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  for (const operation of operations) {
    if (operation.path === "") throw new Error("Replacing the entire config document is not allowed.");
    const path = pointerSegments(operation.path);
    if (operation.op === "add") addValue(root, path, cloneJson(operation.value));
    else if (operation.op === "remove") removeValue(root, path);
    else if (operation.op === "replace") replaceValue(root, path, cloneJson(operation.value));
    else if (operation.op === "test") {
      if (!isDeepStrictEqual(getValue(root, path), operation.value)) {
        throw new Error(`JSON Patch test failed at ${operation.path}.`);
      }
    } else {
      if (operation.from === undefined) throw new Error(`${operation.op} requires from.`);
      const from = pointerSegments(operation.from);
      const value = cloneJson(getValue(root, from));
      if (operation.op === "move") removeValue(root, from);
      addValue(root, path, value);
    }
  }
  return root as MonoAgentConfigJson;
}

function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  const segments = pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new Error(`Unsafe JSON Pointer segment: ${segment}`);
    }
  }
  return segments;
}

function parentAt(root: Record<string, unknown>, segments: readonly string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (segments.length === 0) throw new Error("Root JSON Patch operations are not allowed.");
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment, current.length, false);
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new Error(`JSON Patch path does not exist: /${segments.join("/")}`);
    }
  }
  if (!Array.isArray(current) && !isRecord(current)) {
    throw new Error(`JSON Patch parent is not a container: /${segments.join("/")}`);
  }
  return { parent: current, key: segments.at(-1)! };
}

function addValue(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
    parent.splice(index, 0, value);
  } else {
    parent[key] = value;
  }
}

function replaceValue(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) parent[arrayIndex(key, parent.length, false)] = value;
  else {
    if (!Object.hasOwn(parent, key)) throw new Error(`JSON Patch replace target does not exist: /${segments.join("/")}`);
    parent[key] = value;
  }
}

function removeValue(root: Record<string, unknown>, segments: readonly string[]): unknown {
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) return parent.splice(arrayIndex(key, parent.length, false), 1)[0];
  if (!Object.hasOwn(parent, key)) throw new Error(`JSON Patch remove target does not exist: /${segments.join("/")}`);
  const value = parent[key];
  delete parent[key];
  return value;
}

function getValue(root: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length, false)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else throw new Error(`JSON Patch path does not exist: /${segments.join("/")}`);
  }
  return current;
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(segment)) throw new Error(`Invalid JSON Patch array index: ${segment}`);
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) {
    throw new Error(`JSON Patch array index out of bounds: ${segment}`);
  }
  return index;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function assertProposalContainsNoSecrets(
  proposal: AgentConfigurationProposal,
  env: Record<string, string | undefined>,
): void {
  const secretValues = Object.entries(env)
    .filter(([name, value]) => /(?:api.?key|credential|password|secret|token)/iu.test(name) && (value?.length ?? 0) >= 4)
    .map(([, value]) => value!);
  for (const operation of proposal.patch) {
    if (secretBearingPointer(operation.path) || (operation.from !== undefined && secretBearingPointer(operation.from))) {
      throw new Error("Secret-bearing config fields cannot be proposed in chat. Use the masked mono-agent auth or owner-only .env flow.");
    }
    if (containsSecret(operation.value, secretValues)) {
      throw new Error("A proposal matched a configured secret value. It was rejected and will not be displayed or written.");
    }
  }
  if (containsSecret(proposal.rationale, secretValues) || containsSecretLikeValue(proposal.rationale)) {
    throw new Error("The proposal rationale appears to contain a secret. It was rejected.");
  }
  if (proposal.role !== undefined && containsSecret(proposal.role, secretValues)) {
    throw new Error("The proposed Role matched a configured secret value. It was rejected.");
  }
  if (proposal.role !== undefined && containsSecretLikeValue(proposal.role)) {
    throw new Error("The proposed Role appears to contain a secret. It was rejected.");
  }
}

function secretBearingPointer(pointer: string): boolean {
  return pointerSegments(pointer).some((segment) =>
    /(?:api.?key|credential|password|secret|token)/iu.test(segment) && !/(?:env|path)$/iu.test(segment)
  );
}

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => value.includes(secret)) || containsSecretLikeValue(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secrets));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) =>
      (/(?:api.?key|credential|password|secret|token)/iu.test(key) && !/(?:env|path)$/iu.test(key))
      || containsSecret(entry, secrets)
    );
  }
  return false;
}

function containsSecretLikeValue(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+\S{12,}|\d{6,12}:[A-Za-z0-9_-]{20,})\b/u.test(value);
}

function assertNoEnvironmentShadow(
  patch: readonly JsonPatchOperation[],
  env: Record<string, string | undefined>,
): void {
  const shadowed = Object.entries(CONFIG_ENV_KEYS).filter(([field, envKey]) => {
    if ((env[envKey]?.trim().length ?? 0) === 0) return false;
    const pointer = `/${field.split(".").join("/")}`;
    return patch.some((operation) => pathsOverlap(operation.path, pointer));
  });
  if (shadowed.length > 0) {
    throw new Error(
      `The effective environment overrides this proposal (${shadowed.map(([field, key]) => `${field} via ${key}`).join(", ")}). ` +
      "Update or remove the durable environment override first, then run /configure again.",
    );
  }
}

/**
 * Conversational configuration deliberately exposes a small positive surface.
 * New schema fields therefore fail closed until they receive an explicit
 * safety decision here; everything involving paths, providers, credentials,
 * background work, network access, or sandbox policy stays in a guided flow.
 */
const CONVERSATIONAL_CONFIG_POINTERS = new Set([
  "/agent/name",
  "/runtime/effort",
  "/runtime/maxTurns",
  "/runtime/session/mode",
  "/runtime/session/idleTimeoutMs",
  "/runtime/session/rollover",
  "/runtime/session/rolloverTimezone",
  "/runtime/session/rolloverNotice",
  "/context/selectedSkills",
  "/context/skillMaxBytes",
  "/context/skillDisclosure",
  "/memory/maxBytes",
  "/memory/recallTool/enabled",
  "/tools/allowedTools",
  "/tools/disallowedTools",
]);

function assertConversationalPatchAllowed(
  before: MonoAgentConfigJson,
  after: MonoAgentConfigJson,
): void {
  const changed = changedJsonPointers(before, after);
  const unsupported = changed.filter((pointer) => !CONVERSATIONAL_CONFIG_POINTERS.has(pointer));
  if (unsupported.length > 0) {
    throw new Error(
      `Conversational configuration cannot change ${unsupported.join(", ")}. ` +
      "Paths, memory tiers or capture cost, providers/models/routes, embeddings endpoints, credentials, channels/cron/plugins, MCP, sandbox/network policy, exporters, and other new schema fields require the explicit guided flow.",
    );
  }
  if (toolAuthorityBroadened(before.tools, after.tools)) {
    throw new Error("Broader tool authority requires explicit guided confirmation outside the model conversation.");
  }
}

function changedJsonPointers(before: unknown, after: unknown, pointer = ""): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  const beforeObject = isRecord(before);
  const afterObject = isRecord(after);
  if (
    (beforeObject || before === undefined)
    && (afterObject || after === undefined)
    && (beforeObject || afterObject)
  ) {
    const keys = new Set([
      ...(beforeObject ? Object.keys(before) : []),
      ...(afterObject ? Object.keys(after) : []),
    ]);
    if (keys.size === 0) return [pointer || "/"];
    return [...keys].flatMap((key) => changedJsonPointers(
      beforeObject ? before[key] : undefined,
      afterObject ? after[key] : undefined,
      `${pointer}/${escapeJsonPointerSegment(key)}`,
    ));
  }
  return [pointer || "/"];
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function toolAuthorityBroadened(
  before: MonoAgentConfigJson["tools"],
  after: MonoAgentConfigJson["tools"],
): boolean {
  const beforeAllowed = new Set(before?.allowedTools ?? []);
  const afterAllowed = new Set(after?.allowedTools ?? []);
  const beforeDenied = new Set(before?.disallowedTools ?? []);
  const afterDenied = new Set(after?.disallowedTools ?? []);
  const beforeAllowsAll = before?.allowedTools === undefined || beforeAllowed.has("*");
  const afterAllowsAll = after?.allowedTools === undefined || afterAllowed.has("*");

  if (afterAllowsAll) {
    return !beforeAllowsAll || [...beforeDenied].some((tool) => !afterDenied.has(tool));
  }
  return [...afterAllowed].some((tool) =>
    tool !== "*"
    && !afterDenied.has(tool)
    && ((!beforeAllowsAll && !beforeAllowed.has(tool)) || beforeDenied.has(tool))
  );
}

function replaceRoleSection(identity: string, role: string): string {
  const body = role.trim();
  if (body.length === 0 || /^##\s/mu.test(body)) {
    throw new Error("The generated Role must be non-empty and cannot introduce another level-two Identity section.");
  }
  const match = /^## Role\s*\n([\s\S]*?)(?=\n##\s|$)/mu.exec(identity);
  if (match === null || match.index === undefined) {
    throw new Error("IDENTITY.md has no canonical ## Role section to replace safely.");
  }
  const start = match.index;
  const end = start + match[0].length;
  return `${identity.slice(0, start)}## Role\n\n${body}\n${identity.slice(end).replace(/^\n*/u, "\n")}`;
}

function formatPatchOperation(operation: JsonPatchOperation): string {
  if (operation.op === "remove") return `remove ${operation.path}`;
  if (operation.op === "move" || operation.op === "copy") return `${operation.op} ${operation.from} -> ${operation.path}`;
  if (operation.op === "test") return `verify current value at ${operation.path}`;
  const rendered = JSON.stringify(operation.value);
  const compact = rendered === undefined ? "" : rendered.length <= 180 ? rendered : `${rendered.slice(0, 179)}…`;
  return `${operation.op} ${operation.path} = ${compact}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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

async function ensureOwnedDirectoryInside(root: string, path: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  let current = canonicalRoot;
  await assertOwnedDirectory(current, "Current agent folder");
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertOwnedDirectory(current, label);
  }
  return current;
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

function assertOwnedRegularFileInfo(
  info: Stats,
  path: string,
  label: string,
): void {
  if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} must be one regular file with one link: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} must be owned by the current user: ${path}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function isLexicallyInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertLexicalPathInside(root: string, path: string, label: string): void {
  if (!isLexicallyInside(root, path)) {
    throw new Error(`${label} must stay inside the current agent folder: ${path}`);
  }
}

async function assertPreparedSourcesCurrent(
  cwd: string,
  configPath: string,
  prepared: PreparedProposal,
  phase: string,
): Promise<void> {
  const secureConfig = await resolveOwnedRegularFileInside(cwd, configPath, "Config file");
  const current = await readMonoAgentConfigJson(secureConfig);
  if (current.version !== prepared.expectedConfigVersion) {
    throw new Error(`Configuration changed ${phase}. Nothing was written; run /configure again.`);
  }
  if (prepared.rolePath !== undefined) {
    const secureRole = await resolveOwnedRegularFileInside(cwd, prepared.rolePath, "Identity file");
    const currentRole = await readFile(secureRole, "utf8");
    if (sha256(currentRole) !== prepared.expectedRoleHash) {
      throw new Error(`IDENTITY.md changed ${phase}. Nothing was written; run /configure again.`);
    }
  }
}

async function assertExactOwnedContents(
  cwd: string,
  path: string,
  expected: string,
  label: string,
): Promise<void> {
  const securePath = await resolveOwnedRegularFileInside(cwd, path, label);
  if (await readFile(securePath, "utf8") !== expected) {
    throw new Error(`${label}; the concurrent edit was preserved.`);
  }
}

async function restoreIfExact(cwd: string, path: string, expected: string, restore: string): Promise<void> {
  await atomicReplaceExact(cwd, path, expected, restore);
}

async function atomicReplaceExact(
  root: string,
  path: string,
  expected: string,
  contents: string,
): Promise<void> {
  const securePath = await resolveOwnedRegularFileInside(root, path, "Configuration transaction file");
  const info = await lstat(securePath);
  const temporary = join(dirname(securePath), `.${randomUUID()}.mono-agent-tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      info.mode & 0o777,
    );
    await handle.writeFile(contents, "utf8");
    await handle.chmod(info.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Temp creation and fsync intentionally happen before the last source
    // comparison. From that comparison through rename there is no JavaScript
    // yield: an editor that reacts to the staged temp is observed, while a
    // cooperating mono-agent writer is also serialized by the owner lock.
    commitAtomicReplacementSync(root, securePath, temporary, expected, info);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function commitAtomicReplacementSync(
  root: string,
  path: string,
  temporary: string,
  expected: string,
  initialInfo: Stats,
): void {
  const securePath = resolveOwnedRegularFileInsideSync(root, path, "Configuration transaction file");
  let sourceHandle: number | undefined;
  try {
    sourceHandle = openSync(securePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(sourceHandle);
    assertOwnedRegularFileInfo(openedBefore, securePath, "Configuration transaction file");
    const current = readFileSync(sourceHandle, "utf8");
    const openedAfter = fstatSync(sourceHandle);
    const named = lstatSync(securePath);
    if (
      current !== expected
      || !sameFileIdentityAndMetadata(initialInfo, openedBefore)
      || !sameFileIdentityAndMetadata(openedBefore, openedAfter)
      || !sameFileIdentityAndMetadata(openedAfter, named)
    ) {
      throw new Error(`Refusing to replace changed file ${securePath}; the concurrent edit was preserved.`);
    }
    renameSync(temporary, securePath);
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
  }
}

function resolveOwnedRegularFileInsideSync(root: string, path: string, label: string): string {
  const canonicalRoot = realpathSync(resolve(root));
  const absolute = resolve(path);
  assertLexicalPathInside(canonicalRoot, absolute, label);
  const segments = relative(canonicalRoot, absolute).split(sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`${label} must name a file inside the current agent folder.`);

  let parent = canonicalRoot;
  assertOwnedDirectoryInfo(lstatSync(parent), parent, "Current agent folder");
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    assertOwnedDirectoryInfo(lstatSync(parent), parent, `${label} parent`);
  }
  const target = join(parent, segments.at(-1)!);
  assertOwnedRegularFileInfo(lstatSync(target), target, label);
  const canonicalTarget = realpathSync(target);
  assertLexicalPathInside(canonicalRoot, canonicalTarget, label);
  if (canonicalTarget !== target) {
    throw new Error(`${label} must not traverse a symbolic-link parent: ${path}`);
  }
  return target;
}

function sameFileIdentityAndMetadata(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function withConfigurationTransactionLock<T>(
  cwd: string,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const monoAgentDir = await ensureOwnedDirectoryInside(cwd, join(cwd, ".mono-agent"), "Configuration state directory");
  const lockPath = join(monoAgentDir, "configuration.lock");
  const token = randomUUID();
  const contents = `${JSON.stringify({
    schema: "mono-agent.configuration-lock.v1",
    pid: process.pid,
    token,
    label: safeFilePart(label),
    createdAt: new Date().toISOString(),
  })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Another local configuration transaction owns ${lockPath}. Wait for it to finish; inspect and remove the lock manually only if its owner crashed.`,
        );
      }
      throw error;
    }
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const info = await handle.stat();
    assertOwnedRegularFileInfo(info, lockPath, "Configuration transaction lock");
    identity = { dev: info.dev, ino: info.ino };
    await handle.close();
    handle = undefined;
    return await operation();
  } finally {
    await handle?.close();
    if (identity !== undefined) {
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        current === undefined
        || current.dev !== identity.dev
        || current.ino !== identity.ino
        || await readFile(lockPath, "utf8") !== contents
      ) {
        throw new Error(`Configuration transaction lock changed unexpectedly and was left untouched: ${lockPath}`);
      }
      await rm(lockPath);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
