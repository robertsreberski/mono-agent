import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { APP_ID } from "./content.js";

export type McpAppAuditBeforeOperation = ((operation: "append" | "lstat" | "readdir" | "remove" | "rename", path: string) => void | Promise<void>) | undefined;

// Darwin's O_NOFOLLOW_ANY rejects symbolic links in every path component.
// Node does not expose it, but openSync accepts the stable fcntl.h value.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

interface McpAppAuditStorageOptions {
  readonly maxBytes: number;
  readonly fileMaxBytes: number;
  readonly retainedFiles: number;
}

interface McpAppAuditStorageState extends McpAppAuditStorageOptions {
  readonly root: string;
  readonly beforeOperation: McpAppAuditBeforeOperation;
  readonly owners: Map<string, McpAppAuditOwner>;
  readonly reservations: Map<symbol, { readonly directory: string; readonly bytes: number }>;
  readonly protectionPredicates: Set<(directory: string) => boolean>;
  rootIdentity?: McpAppAuditDirectoryIdentity;
  rootRealPath?: string;
  initialized: boolean;
  gate: Promise<void>;
}

export interface McpAppAuditCompletionReservation {
  append(line: string): Promise<void>;
  release(): Promise<void>;
}

export interface McpAppAuditStorage {
  append(directory: string, line: string): Promise<void>;
  reserveAppend(
    directory: string,
    line: string,
    reservedBytes: number,
  ): Promise<McpAppAuditCompletionReservation>;
  remove(directory: string): Promise<void>;
  dispose(): void;
}

// Intentionally process-global: services sharing one root must share the same
// append gate and exactly one initialization inventory. Disposing/re-creating a
// service unregisters only its live/protected-owner predicate; clearing this
// state would split serialization and repeat the bounded root inventory.
const mcpAppAuditStorageStates = new Map<string, McpAppAuditStorageState>();

export function mcpAppAuditStorageFor(
  root: string,
  options: McpAppAuditStorageOptions,
  beforeOperation: McpAppAuditBeforeOperation,
  isOwnerProtected: (directory: string) => boolean,
): McpAppAuditStorage {
  const canonicalRoot = resolve(root);
  const existing = mcpAppAuditStorageStates.get(canonicalRoot);
  if (
    existing !== undefined
    && (
      existing.maxBytes !== options.maxBytes
      || existing.fileMaxBytes !== options.fileMaxBytes
      || existing.retainedFiles !== options.retainedFiles
      || existing.beforeOperation !== beforeOperation
    )
  ) {
    throw new RangeError("MCP App audit storage options must agree for one artifact root.");
  }
  const state = existing ?? {
    root: canonicalRoot,
    ...options,
    beforeOperation,
    owners: new Map<string, McpAppAuditOwner>(),
    reservations: new Map<symbol, { readonly directory: string; readonly bytes: number }>(),
    protectionPredicates: new Set<(directory: string) => boolean>(),
    initialized: false,
    gate: Promise.resolve(),
  };
  mcpAppAuditStorageStates.set(canonicalRoot, state);
  state.protectionPredicates.add(isOwnerProtected);
  let disposed = false;
  return {
    append: async (directory, line) => await runMcpAppAuditExclusive(
      state,
      async () => await appendMcpAppAudit(state, resolve(directory), line),
    ),
    reserveAppend: async (directory, line, reservedBytes) => {
      if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > state.fileMaxBytes) {
        throw new RangeError("MCP App audit completion reservation is invalid.");
      }
      const canonicalDirectory = resolve(directory);
      const token = Symbol("mcp-app-audit-completion");
      await runMcpAppAuditExclusive(state, async () => {
        await appendMcpAppAudit(state, canonicalDirectory, line, reservedBytes);
        state.reservations.set(token, { directory: canonicalDirectory, bytes: reservedBytes });
      });
      let settled = false;
      return {
        append: async (completionLine) => {
          if (settled) throw new Error("MCP App audit completion reservation was already released.");
          settled = true;
          await runMcpAppAuditExclusive(state, async () => {
            const reservation = state.reservations.get(token);
            if (reservation === undefined) {
              throw new Error("MCP App audit completion reservation is unavailable.");
            }
            const incomingBytes = Buffer.byteLength(completionLine, "utf8");
            if (incomingBytes > reservation.bytes) {
              state.reservations.delete(token);
              throw new Error("MCP App audit completion exceeded its reserved bytes.");
            }
            state.reservations.delete(token);
            await appendMcpAppAudit(state, canonicalDirectory, completionLine);
          });
        },
        release: async () => {
          if (settled) return;
          settled = true;
          await runMcpAppAuditExclusive(state, async () => {
            state.reservations.delete(token);
          });
        },
      };
    },
    remove: async (directory) => await runMcpAppAuditExclusive(
      state,
      async () => {
        const canonicalDirectory = resolve(directory);
        assertMcpAppAuditDirectory(state, canonicalDirectory);
        const tracked = state.owners.get(canonicalDirectory);
        if (tracked?.poisoned === true) {
          throw new Error("MCP App audit cleanup refused a poisoned owner.");
        }
        const initial = await lstat(canonicalDirectory);
        if (!initial.isDirectory() || initial.isSymbolicLink()) {
          throw new Error("MCP App audit cleanup refused an unsafe owner directory.");
        }
        const expectedIdentity = tracked?.identity ?? mcpAppAuditIdentity(initial);
        if (!sameMcpAppAuditIdentity(mcpAppAuditIdentity(initial), expectedIdentity)) {
          throw new Error("MCP App audit cleanup refused a replaced owner directory.");
        }
        await beforeMcpAppAuditOperation(state, "remove", canonicalDirectory);
        const current = await lstat(canonicalDirectory);
        if (
          !current.isDirectory()
          || current.isSymbolicLink()
          || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(current), expectedIdentity)
        ) {
          throw new Error("MCP App audit cleanup refused an unsafe owner directory.");
        }
        const opened = await openMcpAppAuditOwner(
          state,
          canonicalDirectory,
          expectedIdentity,
        );
        try {
          assertOpenedMcpAppAuditOwnerSync(state, opened);
          rmSync(mcpAppAuditChildPath(opened.root, basename(canonicalDirectory)), {
            recursive: true,
            force: true,
          });
          assertOpenedMcpAppAuditDirectorySync(state, opened.root);
        } finally {
          await closeOpenedMcpAppAuditOwner(opened);
        }
        if (!state.initialized) return;
        replaceMcpAppAuditOwner(state, canonicalDirectory, undefined);
      },
    ),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      state.protectionPredicates.delete(isOwnerProtected);
    },
  };
}

interface McpAppAuditDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OpenedMcpAppAuditDirectory {
  readonly path: string;
  readonly identity: McpAppAuditDirectoryIdentity;
  readonly realPath: string;
  readonly handle: FileHandle;
}

interface OpenedMcpAppAuditOwner {
  readonly root: OpenedMcpAppAuditDirectory;
  readonly owner: OpenedMcpAppAuditDirectory;
}

interface McpAppAuditFile {
  readonly directory: string;
  readonly index: number;
  readonly size: number;
  readonly path: string;
  readonly modifiedAtMs: number;
  readonly identity: McpAppAuditDirectoryIdentity;
  readonly reclaimable: boolean;
}

interface McpAppAuditOwner {
  readonly directory: string;
  readonly identity?: McpAppAuditDirectoryIdentity;
  readonly files: Map<number, McpAppAuditFile>;
  readonly reservedBytes: number;
  readonly poisoned: boolean;
}

async function appendMcpAppAudit(
  state: McpAppAuditStorageState,
  directory: string,
  line: string,
  additionalReservedBytes = 0,
): Promise<void> {
  assertMcpAppAuditDirectory(state, directory);
  const incomingBytes = Buffer.byteLength(line, "utf8");
  if (incomingBytes > state.fileMaxBytes) {
    throw new Error("MCP App audit entry exceeded its file ceiling.");
  }

  await initializeMcpAppAuditStorage(state, directory);
  let owner = await reconcileTargetMcpAppAuditOwner(state, directory);
  // Foreign poisoned owners retain their bounded reservation for this process.
  // Only a fresh service process may inventory their filesystem paths again.
  const currentBytes = owner.files.get(0)?.size ?? 0;
  const rotates = currentBytes > 0 && currentBytes > state.fileMaxBytes - incomingBytes;
  const releasedFile = rotates ? owner.files.get(state.retainedFiles) : undefined;
  await admitMcpAppAuditAppend(
    state,
    directory,
    releasedFile,
    incomingBytes,
    additionalReservedBytes,
  );

  if (rotates) await rotateTrackedMcpAppAuditFiles(state, directory);
  owner = state.owners.get(directory) ?? emptyMcpAppAuditOwner(directory);
  if (owner.identity === undefined) {
    throw new Error("MCP App audit owner identity is unavailable.");
  }
  const active = owner.files.get(0);
  const expectedBytes = active?.size ?? 0;
  let committed: {
    readonly size: number;
    readonly modifiedAtMs: number;
    readonly identity: McpAppAuditDirectoryIdentity;
  };
  try {
    committed = await appendMcpAppAuditLine(
      state,
      owner,
      join(directory, "audit.jsonl"),
      line,
      expectedBytes,
      active,
    );
  } catch (error) {
    quarantineMcpAppAuditOwner(state, directory, addMcpAppAuditBytes(
      mcpAppAuditOwnerBytes(owner),
      incomingBytes,
    ));
    throw error;
  }
  const files = new Map(owner.files);
  files.set(0, {
    directory,
    index: 0,
    size: committed.size,
    path: join(directory, "audit.jsonl"),
    modifiedAtMs: committed.modifiedAtMs,
    identity: committed.identity,
    reclaimable: true,
  });
  replaceMcpAppAuditOwner(state, directory, {
    directory,
    identity: owner.identity,
    files,
    reservedBytes: 0,
    poisoned: false,
  });
  if (projectedMcpAppAuditBytes(state, undefined, 0, additionalReservedBytes) > state.maxBytes) {
    throw new Error("MCP App audit storage exceeded its aggregate ceiling.");
  }
}

async function admitMcpAppAuditAppend(
  state: McpAppAuditStorageState,
  targetDirectory: string,
  naturallyReleased: McpAppAuditFile | undefined,
  incomingBytes: number,
  additionalReservedBytes: number,
): Promise<void> {
  if (
    projectedMcpAppAuditBytes(
      state,
      naturallyReleased,
      incomingBytes,
      additionalReservedBytes,
    ) <= state.maxBytes
  ) return;

  const attempted = new Set<string>();
  while (
    projectedMcpAppAuditBytes(
      state,
      naturallyReleased,
      incomingBytes,
      additionalReservedBytes,
    ) > state.maxBytes
  ) {
    const reclaimablePaths = mcpAppAuditReclaimablePaths(
      state,
      targetDirectory,
      naturallyReleased,
      attempted,
    );
    if (
      projectedMcpAppAuditBytes(
        state,
        naturallyReleased,
        incomingBytes,
        additionalReservedBytes,
        reclaimablePaths,
      ) > state.maxBytes
    ) {
      throw new Error("MCP App audit storage is full.");
    }
    const candidate = nextMcpAppAuditReclamationCandidate(
      state,
      targetDirectory,
      naturallyReleased,
      incomingBytes,
      attempted,
    );
    if (candidate === undefined) break;
    attempted.add(candidate.path);
    try {
      const removed = await removeMcpAppAuditPathUnlessProtected(
        state,
        candidate,
        { force: true },
      );
      if (!removed) continue;
      removeTrackedMcpAppAuditFile(state, candidate);
    } catch {
      markMcpAppAuditFileUnreclaimable(state, candidate);
      if (candidate.directory === targetDirectory) {
        throw new Error("MCP App audit history could not be reclaimed safely.");
      }
    }
  }
  if (
    projectedMcpAppAuditBytes(
      state,
      naturallyReleased,
      incomingBytes,
      additionalReservedBytes,
    ) > state.maxBytes
  ) {
    throw new Error("MCP App audit storage is full.");
  }
}

async function initializeMcpAppAuditStorage(
  state: McpAppAuditStorageState,
  targetDirectory: string,
): Promise<void> {
  if (state.initialized) return;
  let root: OpenedMcpAppAuditDirectory | undefined;
  let entries: Dirent[];
  try {
    root = await openMcpAppAuditRoot(state);
    entries = await readMcpAppAuditDirectory(
      state,
      state.root,
      async () => await assertOpenedMcpAppAuditDirectory(state, root!),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      state.initialized = true;
      return;
    }
    throw error;
  } finally {
    await root?.handle.close().catch(() => undefined);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !APP_ID.test(entry.name)) continue;
    const directory = join(state.root, entry.name);
    const owner = await inventoryMcpAppAuditOwner(state, directory, directory === targetDirectory);
    if (directory === targetDirectory || mcpAppAuditOwnerBytes(owner) > 0) {
      replaceMcpAppAuditOwner(state, directory, owner);
    }
  }
  state.initialized = true;
}

async function reconcileTargetMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
): Promise<McpAppAuditOwner> {
  const tracked = state.owners.get(directory);
  if (tracked?.poisoned === true) {
    throw new Error("MCP App audit target is quarantined for this process.");
  }
  const owner = await inventoryMcpAppAuditOwner(state, directory, true, tracked?.identity);
  replaceMcpAppAuditOwner(state, directory, owner);
  return owner;
}

async function inventoryMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
  strict: boolean,
  expectedIdentity?: McpAppAuditDirectoryIdentity,
): Promise<McpAppAuditOwner> {
  let observedIdentity = expectedIdentity;
  let opened: OpenedMcpAppAuditOwner | undefined;
  let entries: Dirent[];
  try {
    const initial = await lstatMcpAppAuditPath(state, directory);
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new Error("MCP App audit target is not a safe invocation directory.");
    }
    const initialIdentity = mcpAppAuditIdentity(initial);
    if (expectedIdentity !== undefined && !sameMcpAppAuditIdentity(initialIdentity, expectedIdentity)) {
      throw new Error("MCP App audit invocation directory identity changed.");
    }
    observedIdentity = initialIdentity;
    opened = await openMcpAppAuditOwner(state, directory, expectedIdentity ?? initialIdentity);
    entries = await readMcpAppAuditDirectory(
      state,
      directory,
      async () => await assertOpenedMcpAppAuditOwner(state, opened!),
    );
  } catch (error) {
    if (opened !== undefined) await closeOpenedMcpAppAuditOwner(opened);
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && expectedIdentity === undefined) {
      return emptyMcpAppAuditOwner(directory);
    }
    if (strict) throw error;
    return poisonedMcpAppAuditOwner(state, directory, 0, observedIdentity);
  }
  const identity = opened.owner.identity;
  const files = new Map<number, McpAppAuditFile>();
  try {
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const index = mcpAppAuditFileIndex(entry.name);
      if (index === undefined) continue;
      const path = join(directory, entry.name);
      let fileStat: Stats;
      try {
        fileStat = await lstatMcpAppAuditPath(
          state,
          path,
          async () => await assertOpenedMcpAppAuditOwner(state, opened!),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (strict) throw error;
        return poisonedMcpAppAuditOwner(
          state,
          directory,
          mcpAppAuditFilesBytes(files),
          identity,
        );
      }
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
        if (strict) throw new Error("MCP App audit storage contains an unsafe file.");
        return poisonedMcpAppAuditOwner(
          state,
          directory,
          addMcpAppAuditBytes(
            mcpAppAuditFilesBytes(files),
            fileStat.isFile() && Number.isSafeInteger(fileStat.size) ? fileStat.size : 0,
          ),
          identity,
        );
      }
      const file: McpAppAuditFile = {
        directory,
        index,
        size: fileStat.size,
        path,
        modifiedAtMs: fileStat.mtimeMs,
        identity: mcpAppAuditIdentity(fileStat),
        reclaimable: true,
      };
      if (index === 0 && fileStat.size > state.fileMaxBytes) {
        if (strict) {
          throw new Error("MCP App audit file exceeded its configured ceiling.");
        }
        files.set(index, file);
        continue;
      }
      if (index > state.retainedFiles || fileStat.size > state.fileMaxBytes) {
        try {
          await removeMcpAppAuditPath(state, file, { force: true }, opened);
        } catch {
          if (strict) throw new Error("MCP App audit history could not be bounded safely.");
          return poisonedMcpAppAuditOwner(
            state,
            directory,
            addMcpAppAuditBytes(mcpAppAuditFilesBytes(files), fileStat.size),
            identity,
          );
        }
        continue;
      }
      files.set(index, {
        ...file,
      });
    }
    await assertOpenedMcpAppAuditOwner(state, opened);
    return { directory, identity, files, reservedBytes: 0, poisoned: false };
  } finally {
    await closeOpenedMcpAppAuditOwner(opened);
  }
}

function nextMcpAppAuditReclamationCandidate(
  state: McpAppAuditStorageState,
  targetDirectory: string,
  naturallyReleased: McpAppAuditFile | undefined,
  incomingBytes: number,
  attempted: ReadonlySet<string>,
): McpAppAuditFile | undefined {
  const fairShare = Math.floor(state.maxBytes / Math.max(1, state.owners.size));
  const eligible = [...state.owners.values()].flatMap((owner) => [...owner.files.values()])
    .filter((candidate) => isMcpAppAuditReclamationCandidate(
      state,
      candidate,
      targetDirectory,
      naturallyReleased,
      attempted,
    ));
  const tier = eligible.some((candidate) => candidate.index > 0) ? "rotated" : "inactive-active";
  const candidates = [...state.owners.entries()].flatMap(([directory, owner]) => {
    const file = [...owner.files.values()]
      .filter((candidate) => (
        isMcpAppAuditReclamationCandidate(
          state,
          candidate,
          targetDirectory,
          naturallyReleased,
          attempted,
        )
        && (tier === "rotated" ? candidate.index > 0 : candidate.index === 0)
      ))
      .sort(compareMcpAppAuditAge)[0];
    if (file === undefined) return [];
    const bytes = addMcpAppAuditBytes(
      Math.max(0, mcpAppAuditOwnerBytes(owner) - (
        directory === targetDirectory ? naturallyReleased?.size ?? 0 : 0
      )),
      directory === targetDirectory ? incomingBytes : 0,
    );
    return [{ directory, bytes, file }];
  });
  if (candidates.length === 0) return undefined;
  const aboveShare = candidates.filter((candidate) => candidate.bytes > fairShare);
  const pool = aboveShare.length > 0 ? aboveShare : candidates;
  pool.sort((left, right) => (
    right.bytes - left.bytes
      || compareMcpAppAuditAge(left.file, right.file)
      || left.directory.localeCompare(right.directory)
  ));
  return pool[0]!.file;
}

function mcpAppAuditReclaimablePaths(
  state: McpAppAuditStorageState,
  targetDirectory: string,
  naturallyReleased: McpAppAuditFile | undefined,
  attempted: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...state.owners.values()].flatMap((owner) => [...owner.files.values()])
    .filter((candidate) => isMcpAppAuditReclamationCandidate(
      state,
      candidate,
      targetDirectory,
      naturallyReleased,
      attempted,
    ))
    .map((candidate) => candidate.path));
}

function isMcpAppAuditReclamationCandidate(
  state: McpAppAuditStorageState,
  candidate: McpAppAuditFile,
  targetDirectory: string,
  naturallyReleased: McpAppAuditFile | undefined,
  attempted: ReadonlySet<string>,
): boolean {
  if (
    !candidate.reclaimable
    || candidate.path === naturallyReleased?.path
    || attempted.has(candidate.path)
  ) return false;
  if (candidate.index > 0) return true;
  return candidate.directory !== targetDirectory
    && !isMcpAppAuditOwnerProtected(state, candidate.directory);
}

function isMcpAppAuditOwnerProtected(state: McpAppAuditStorageState, directory: string): boolean {
  for (const reservation of state.reservations.values()) {
    if (reservation.directory === directory) return true;
  }
  for (const predicate of state.protectionPredicates) {
    try {
      if (predicate(directory)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function projectedMcpAppAuditBytes(
  state: McpAppAuditStorageState,
  naturallyReleased: McpAppAuditFile | undefined,
  incomingBytes: number,
  additionalReservedBytes = 0,
  excludedPaths: ReadonlySet<string> = new Set<string>(),
): number {
  const ceiling = state.maxBytes + 1;
  let total = 0;
  const add = (bytes: number): void => {
    total = Math.min(ceiling, addMcpAppAuditBytes(total, bytes));
  };
  for (const owner of state.owners.values()) {
    if (owner.poisoned) add(Math.min(state.maxBytes, owner.reservedBytes));
    for (const file of owner.files.values()) {
      if (file.path === naturallyReleased?.path || excludedPaths.has(file.path)) continue;
      add(file.size);
    }
  }
  for (const reservation of state.reservations.values()) add(reservation.bytes);
  add(incomingBytes);
  add(additionalReservedBytes);
  return total;
}

function emptyMcpAppAuditOwner(directory: string): McpAppAuditOwner {
  return { directory, files: new Map(), reservedBytes: 0, poisoned: false };
}

function poisonedMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
  minimumBytes = 0,
  identity?: McpAppAuditDirectoryIdentity,
): McpAppAuditOwner {
  const ownerCapacity = state.fileMaxBytes * (state.retainedFiles + 1);
  return {
    directory,
    ...(identity === undefined ? {} : { identity }),
    files: new Map(),
    // Unknown owners consume their full safe owner capacity, while the
    // aggregate projection saturates just above maxBytes. More poisoned owners
    // can therefore never overflow accounting or create admission headroom.
    reservedBytes: Math.min(state.maxBytes, Math.max(ownerCapacity, minimumBytes)),
    poisoned: true,
  };
}

function quarantineMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
  minimumBytes: number,
): void {
  replaceMcpAppAuditOwner(
    state,
    directory,
    poisonedMcpAppAuditOwner(state, directory, minimumBytes, state.owners.get(directory)?.identity),
  );
}

function mcpAppAuditFilesBytes(files: ReadonlyMap<number, McpAppAuditFile>): number {
  let total = 0;
  for (const file of files.values()) total = addMcpAppAuditBytes(total, file.size);
  return total;
}

function mcpAppAuditOwnerBytes(owner: McpAppAuditOwner): number {
  return addMcpAppAuditBytes(owner.reservedBytes, mcpAppAuditFilesBytes(owner.files));
}

function replaceMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
  owner: McpAppAuditOwner | undefined,
): void {
  if (owner === undefined) {
    state.owners.delete(directory);
    return;
  }
  state.owners.set(directory, owner);
}

function removeTrackedMcpAppAuditFile(
  state: McpAppAuditStorageState,
  file: McpAppAuditFile,
): void {
  const owner = state.owners.get(file.directory);
  const tracked = owner?.files.get(file.index);
  if (owner === undefined || tracked?.path !== file.path) return;
  const files = new Map(owner.files);
  files.delete(file.index);
  replaceMcpAppAuditOwner(state, file.directory, {
    ...owner,
    files,
  });
}

function markMcpAppAuditFileUnreclaimable(
  state: McpAppAuditStorageState,
  file: McpAppAuditFile,
): void {
  const owner = state.owners.get(file.directory);
  const tracked = owner?.files.get(file.index);
  if (owner === undefined || tracked?.path !== file.path) return;
  const files = new Map(owner.files);
  files.set(file.index, { ...tracked, reclaimable: false });
  replaceMcpAppAuditOwner(state, file.directory, { ...owner, files });
}

async function rotateTrackedMcpAppAuditFiles(
  state: McpAppAuditStorageState,
  directory: string,
): Promise<void> {
  let owner = state.owners.get(directory) ?? emptyMcpAppAuditOwner(directory);
  const released = owner.files.get(state.retainedFiles);
  if (released !== undefined) {
    await removeMcpAppAuditPath(state, released, { force: true });
    removeTrackedMcpAppAuditFile(state, released);
  }
  for (let index = state.retainedFiles; index >= 1; index -= 1) {
    owner = state.owners.get(directory) ?? emptyMcpAppAuditOwner(directory);
    const source = owner.files.get(index - 1);
    if (source === undefined) continue;
    const destinationPath = join(directory, `audit.${index}.jsonl`);
    await renameMcpAppAuditPath(state, source, destinationPath);
    const files = new Map(owner.files);
    files.delete(index - 1);
    files.set(index, {
      ...source,
      index,
      path: destinationPath,
    });
    replaceMcpAppAuditOwner(state, directory, { ...owner, files });
  }
}

async function appendMcpAppAuditLine(
  state: McpAppAuditStorageState,
  owner: McpAppAuditOwner,
  path: string,
  line: string,
  expectedBytes: number,
  expectedFile: McpAppAuditFile | undefined,
): Promise<{
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly identity: McpAppAuditDirectoryIdentity;
}> {
  if (owner.identity === undefined) throw new Error("MCP App audit owner identity is unavailable.");
  await beforeMcpAppAuditOperation(state, "append", path);
  const opened = await openMcpAppAuditOwner(state, owner.directory, owner.identity);
  const childPath = mcpAppAuditChildPath(opened.owner, basename(path));
  const flags = fsConstants.O_APPEND
    | fsConstants.O_WRONLY
    | (expectedFile === undefined ? fsConstants.O_CREAT | fsConstants.O_EXCL : 0)
    | (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (fsConstants.O_NOFOLLOW ?? 0));
  let descriptor: number | undefined;
  try {
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    descriptor = openSync(childPath, flags, 0o600);
    const before = fstatSync(descriptor);
    const current = lstatSync(childPath);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size !== expectedBytes
      || !sameMcpAppAuditFileIdentity(before, current)
      || (expectedFile !== undefined && !sameMcpAppAuditIdentity(
        mcpAppAuditIdentity(before),
        expectedFile.identity,
      ))
    ) {
      throw new Error("MCP App audit storage changed during append admission.");
    }
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    const lineBuffer = Buffer.from(line, "utf8");
    let written = 0;
    while (written < lineBuffer.length) {
      const bytesWritten = writeSync(
        descriptor,
        lineBuffer,
        written,
        lineBuffer.length - written,
        null,
      );
      if (bytesWritten === 0) throw new Error("MCP App audit append made no forward progress.");
      written += bytesWritten;
    }
    const after = fstatSync(descriptor);
    const currentAfter = lstatSync(childPath);
    const lineBytes = lineBuffer.length;
    if (
      written !== lineBytes
      || !after.isFile()
      || after.nlink !== 1
      || after.size !== expectedBytes + lineBytes
      || after.size > state.fileMaxBytes
      || !sameMcpAppAuditFileIdentity(after, currentAfter)
    ) {
      throw new Error("MCP App audit append did not preserve its physical file ceiling.");
    }
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    return {
      size: after.size,
      modifiedAtMs: after.mtimeMs,
      identity: mcpAppAuditIdentity(after),
    };
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      await closeOpenedMcpAppAuditOwner(opened);
    }
  }
}

function assertMcpAppAuditDirectory(state: McpAppAuditStorageState, directory: string): void {
  if (resolve(directory, "..") !== state.root || !APP_ID.test(basename(directory))) {
    throw new Error("MCP App audit target escaped its owned invocation directory.");
  }
}

async function beforeMcpAppAuditOperation(
  state: McpAppAuditStorageState,
  operation: "append" | "lstat" | "readdir" | "remove" | "rename",
  path: string,
): Promise<void> {
  await state.beforeOperation?.(operation, path);
}

async function readMcpAppAuditDirectory(
  state: McpAppAuditStorageState,
  path: string,
  assertParent?: () => Promise<void>,
): Promise<Dirent[]> {
  await beforeMcpAppAuditOperation(state, "readdir", path);
  await assertParent?.();
  const entries = await readdir(path, { withFileTypes: true });
  await assertParent?.();
  return entries;
}

async function lstatMcpAppAuditPath(
  state: McpAppAuditStorageState,
  path: string,
  assertParent?: () => Promise<void>,
): Promise<Stats> {
  await beforeMcpAppAuditOperation(state, "lstat", path);
  await assertParent?.();
  const details = await lstat(path);
  await assertParent?.();
  return details;
}

async function removeMcpAppAuditPath(
  state: McpAppAuditStorageState,
  file: McpAppAuditFile,
  options: { readonly recursive?: boolean; readonly force?: boolean },
  existingOwner?: OpenedMcpAppAuditOwner,
): Promise<void> {
  await removeMcpAppAuditFile(state, file, options, false, existingOwner);
}

async function removeMcpAppAuditPathUnlessProtected(
  state: McpAppAuditStorageState,
  file: McpAppAuditFile,
  options: { readonly recursive?: boolean; readonly force?: boolean },
): Promise<boolean> {
  return await removeMcpAppAuditFile(state, file, options, true);
}

async function renameMcpAppAuditPath(
  state: McpAppAuditStorageState,
  source: McpAppAuditFile,
  destination: string,
): Promise<void> {
  const owner = state.owners.get(source.directory);
  if (owner?.identity === undefined) throw new Error("MCP App audit owner identity is unavailable.");
  await beforeMcpAppAuditOperation(state, "rename", source.path);
  const opened = await openMcpAppAuditOwner(state, source.directory, owner.identity);
  try {
    const sourcePath = mcpAppAuditChildPath(opened.owner, basename(source.path));
    const destinationPath = mcpAppAuditChildPath(opened.owner, basename(destination));
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    const currentSource = lstatSync(sourcePath);
    assertMcpAppAuditFileSnapshot(currentSource, source);
    try {
      lstatSync(destinationPath);
      throw new Error("MCP App audit rotation destination changed unexpectedly.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    renameSync(sourcePath, destinationPath);
    const currentDestination = lstatSync(destinationPath);
    assertMcpAppAuditFileSnapshot(currentDestination, source);
    assertOpenedMcpAppAuditOwnerSync(state, opened);
  } finally {
    await closeOpenedMcpAppAuditOwner(opened);
  }
}

async function removeMcpAppAuditFile(
  state: McpAppAuditStorageState,
  file: McpAppAuditFile,
  options: { readonly recursive?: boolean; readonly force?: boolean },
  respectProtection: boolean,
  existingOwner?: OpenedMcpAppAuditOwner,
): Promise<boolean> {
  if (options.recursive === true) {
    throw new Error("MCP App audit reclamation never recursively removes an owner entry.");
  }
  const trackedOwner = state.owners.get(file.directory);
  const identity = existingOwner?.owner.identity ?? trackedOwner?.identity;
  if (identity === undefined) throw new Error("MCP App audit owner identity is unavailable.");
  await beforeMcpAppAuditOperation(state, "remove", file.path);
  const opened = existingOwner ?? await openMcpAppAuditOwner(state, file.directory, identity);
  try {
    const childPath = mcpAppAuditChildPath(opened.owner, basename(file.path));
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    const current = lstatSync(childPath);
    assertMcpAppAuditFileSnapshot(current, file);
    if (respectProtection && file.index === 0 && isMcpAppAuditOwnerProtected(state, file.directory)) {
      return false;
    }
    // Keep the final validation and unlink in one synchronous critical section:
    // no in-process task can swap the parent between check and use. Linux child
    // paths are descriptor-relative; Darwin append opens also use NOFOLLOW_ANY.
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    rmSync(childPath, options);
    assertOpenedMcpAppAuditOwnerSync(state, opened);
    return true;
  } finally {
    if (existingOwner === undefined) await closeOpenedMcpAppAuditOwner(opened);
  }
}

async function openMcpAppAuditRoot(
  state: McpAppAuditStorageState,
): Promise<OpenedMcpAppAuditDirectory> {
  const opened = await openVerifiedMcpAppAuditDirectory(
    state.root,
    state.rootIdentity,
    state.rootRealPath,
  );
  if (state.rootIdentity === undefined) {
    state.rootIdentity = opened.identity;
    state.rootRealPath = opened.realPath;
  }
  return opened;
}

async function openMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  directory: string,
  expectedIdentity: McpAppAuditDirectoryIdentity,
): Promise<OpenedMcpAppAuditOwner> {
  assertMcpAppAuditDirectory(state, directory);
  const root = await openMcpAppAuditRoot(state);
  try {
    const owner = await openVerifiedMcpAppAuditDirectory(
      directory,
      expectedIdentity,
      join(root.realPath, basename(directory)),
    );
    const opened = { root, owner };
    await assertOpenedMcpAppAuditOwner(state, opened);
    return opened;
  } catch (error) {
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

async function openVerifiedMcpAppAuditDirectory(
  path: string,
  expectedIdentity?: McpAppAuditDirectoryIdentity,
  expectedRealPath?: string,
): Promise<OpenedMcpAppAuditDirectory> {
  const initial = await lstat(path);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error("MCP App audit storage traversed an unsafe directory entry.");
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY
      | (fsConstants.O_DIRECTORY ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0)
      | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const [opened, current, currentRealPath] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path),
    ]);
    const identity = mcpAppAuditIdentity(opened);
    if (
      !opened.isDirectory()
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(initial), identity)
      || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(current), identity)
      || (expectedIdentity !== undefined && !sameMcpAppAuditIdentity(identity, expectedIdentity))
      || (expectedRealPath !== undefined && currentRealPath !== expectedRealPath)
    ) {
      throw new Error("MCP App audit directory identity changed during verification.");
    }
    return { path, identity, realPath: currentRealPath, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertOpenedMcpAppAuditDirectory(
  state: McpAppAuditStorageState,
  opened: OpenedMcpAppAuditDirectory,
): Promise<void> {
  assertOpenedMcpAppAuditDirectorySync(state, opened);
}

async function assertOpenedMcpAppAuditOwner(
  state: McpAppAuditStorageState,
  opened: OpenedMcpAppAuditOwner,
): Promise<void> {
  assertOpenedMcpAppAuditOwnerSync(state, opened);
}

function assertOpenedMcpAppAuditDirectorySync(
  state: McpAppAuditStorageState,
  opened: OpenedMcpAppAuditDirectory,
): void {
  const retained = fstatSync(opened.handle.fd);
  const current = lstatSync(opened.path);
  const currentRealPath = realpathSync(opened.path);
  const rootIdentityChanged = opened.path === state.root
    && state.rootIdentity !== undefined
    && !sameMcpAppAuditIdentity(opened.identity, state.rootIdentity);
  const rootRealPathChanged = opened.path === state.root
    && state.rootRealPath !== undefined
    && opened.realPath !== state.rootRealPath;
  if (
    !retained.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(retained), opened.identity)
    || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(current), opened.identity)
    || currentRealPath !== opened.realPath
    || rootIdentityChanged
    || rootRealPathChanged
  ) {
    throw new Error("MCP App audit directory changed while in use.");
  }
}

function assertOpenedMcpAppAuditOwnerSync(
  state: McpAppAuditStorageState,
  opened: OpenedMcpAppAuditOwner,
): void {
  assertOpenedMcpAppAuditDirectorySync(state, opened.root);
  assertOpenedMcpAppAuditDirectorySync(state, opened.owner);
  if (
    dirname(opened.owner.realPath) !== opened.root.realPath
    || basename(opened.owner.path) !== basename(opened.owner.realPath)
  ) {
    throw new Error("MCP App audit owner escaped its verified audit root.");
  }
}

function mcpAppAuditChildPath(
  opened: OpenedMcpAppAuditDirectory,
  name: string,
): string {
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error("MCP App audit child name is unsafe.");
  }
  return process.platform === "linux"
    ? `/proc/self/fd/${String(opened.handle.fd)}/${name}`
    : join(opened.realPath, name);
}

async function closeOpenedMcpAppAuditOwner(opened: OpenedMcpAppAuditOwner): Promise<void> {
  await Promise.all([
    opened.owner.handle.close().catch(() => undefined),
    opened.root.handle.close().catch(() => undefined),
  ]);
}

function mcpAppAuditIdentity(details: Stats): McpAppAuditDirectoryIdentity {
  return { dev: details.dev, ino: details.ino };
}

function sameMcpAppAuditIdentity(
  left: McpAppAuditDirectoryIdentity,
  right: McpAppAuditDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMcpAppAuditFileIdentity(opened: Stats, current: Stats): boolean {
  return opened.isFile()
    && opened.nlink === 1
    && current.isFile()
    && !current.isSymbolicLink()
    && current.nlink === 1
    && sameMcpAppAuditIdentity(mcpAppAuditIdentity(opened), mcpAppAuditIdentity(current));
}

function assertMcpAppAuditFileSnapshot(current: Stats, expected: McpAppAuditFile): void {
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || current.size !== expected.size
    || !sameMcpAppAuditIdentity(mcpAppAuditIdentity(current), expected.identity)
  ) {
    throw new Error("MCP App audit file identity changed before mutation.");
  }
}

function compareMcpAppAuditAge(left: McpAppAuditFile, right: McpAppAuditFile): number {
  return left.modifiedAtMs - right.modifiedAtMs
    || (left.directory === right.directory ? right.index - left.index : left.path.localeCompare(right.path));
}

function mcpAppAuditFileIndex(name: string): number | undefined {
  if (name === "audit.jsonl") return 0;
  const matched = /^audit\.([1-9][0-9]*)\.jsonl$/u.exec(name);
  if (matched === null) return undefined;
  const index = Number(matched[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function addMcpAppAuditBytes(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

async function runMcpAppAuditExclusive<T>(
  state: McpAppAuditStorageState,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.gate;
  let release!: () => void;
  state.gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
