// Opaque handles and exclusive, non-repairable two-marker consumption.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "./continuity-dataset.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
const instances = new Map();
export function guardedAuthorization(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const { need } = guardedAccounting(protocolId);
  const { assertLease, isLeaseFile, markLeaseCompromised, readLease } = guardedLease(protocolId);
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  const MARKER = "authorization-consumed.json", CLAIM = "claim.json";
  const REGISTRY_DOMAIN = protocol.registryDomain;
  const ACCOUNT_DOMAIN = protocol.accountDomain;
  const matchesAccount = (artifact, account) => typeof account === "string" && account.length > 0
    && sha256(`${ACCOUNT_DOMAIN}${artifact.salt}\0${account}`) === artifact.accountCommitment;
  const handles = new WeakMap();
  const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
  const hash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
  const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  const inside = (a, b) => a === b || (!relative(b, a).startsWith(`..${sep}`) && relative(b, a) !== ".." && !isAbsolute(relative(b, a)));
  const disjoint = (a, b) => !inside(a, b) && !inside(b, a);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
  async function safeDirectory(path, code, privateMode = false) {
    need(isAbsolute(path) && resolve(path) === path, code);
    const uid = userInfo().uid;
    for (let current = path; ; current = dirname(current)) {
      const stat = await lstat(current);
      need(stat.isDirectory() && (stat.uid === uid || stat.uid === 0), code);
      need((stat.mode & 0o022) === 0 || stat.uid === 0 && (stat.mode & 0o1000) !== 0, code);
      if (current === path && privateMode) need(stat.uid === uid && (stat.mode & 0o077) === 0, code);
      if (dirname(current) === current) break;
    }
    need(await realpath(path) === path, code);
    return path;
  }
  async function safeRead(path, code, maxBytes = 4 * 1024 * 1024) {
    need(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 128 * 1024 * 1024, code);
    await safeDirectory(dirname(path), code);
    // Reject aliases BEFORE open: even closing a read-only fd could drop SQLite's POSIX locks.
    const initial = await lstat(path);
    need(initial.isFile() && initial.uid === userInfo().uid && initial.nlink === 1 && (initial.mode & 0o077) === 0
      && !isLeaseFile(path, initial), code);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      // A raced open cannot be undone: closing this fd may drop the process's POSIX locks.
      // Permanently invalidate any affected live lease before allowing any other checks.
      need(!markLeaseCompromised(stat), code);
      need(initial.dev === stat.dev && initial.ino === stat.ino, code);
      need(stat.isFile() && stat.uid === userInfo().uid && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= maxBytes, code);
      const before = await lstat(path);
      need(before.dev === stat.dev && before.ino === stat.ino && !before.isSymbolicLink(), code);
      // Enforce the bound on bytes read, even if this inode grows after stat.
      const chunks = []; let total = 0, eof = false;
      while (total <= maxBytes && !eof) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total)); let used = 0;
        // Coalesce short reads instead of retaining a full backing buffer per byte.
        while (used < buffer.length) {
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
          if (bytesRead === 0) { eof = true; break; }
          used += bytesRead; total += bytesRead; need(total <= maxBytes, code);
        }
        if (used) chunks.push(buffer.subarray(0, used));
      }
      return Buffer.concat(chunks, total);
    } finally { await file.close(); }
  }
  async function safeJson(path, code) {
    try { return JSON.parse((await safeRead(path, code)).toString("utf8")); }
    catch { fail(code); }
  }
  function context(handle) { const ctx = handles.get(handle); need(ctx, protocol.codes.authorization_required); return ctx; }
  function binds(handle, descriptor, catalog) {
    const ctx = handles.get(handle);
    return Boolean(ctx && protocol.hooks.authorizationBinds(ctx.registration, descriptor, catalog, same));
  }
  async function validate(args) {
    try { return await validateArtifact(args); }
    catch (error) {
      // Never leak filesystem paths, credential parser text or arbitrary causes.
      const code = protocol.refusalPattern.test(error?.code ?? "") ? error.code : protocol.codes.authorization_invalid;
      fail(code);
    }
  }
  async function validateArtifact(args) {
    const ctx = await protocol.hooks.validateAuthorization(args, { need, hash, id, safeRead, safeDirectory, fail, disjoint, same, matchesAccount });
    const handle = Object.freeze({}); handles.set(handle, ctx); return handle;
  }
  function bindsRegistration(handle, pilot) {
    const ctx = handles.get(handle);
    return Boolean(ctx && same(ctx.registration, pilot));
  }
  function matchesAccountHandle(handle, account) {
    const ctx = handles.get(handle);
    return Boolean(ctx && matchesAccount(ctx.artifact, account));
  }
  async function revalidate(handle) {
    const ctx = context(handle), fresh = context(await validate(ctx.args));
    need(fresh.rawDigest === ctx.rawDigest && same(fresh.registration, ctx.registration), protocol.codes.authorization_binding_mismatch);
    return fresh;
  }
  async function syncDirectory(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await file.sync(); } finally { await file.close(); }
  }
  async function registry(ctx, create) {
    const code = protocol.codes.authorization_registry_unsafe;
    try {
      const home = userInfo().homedir;
      await safeDirectory(home, code);
      const fixed = join(home, ...protocol.policy.REGISTRY_LAYOUT.map(([name]) => name));
      need(disjoint(fixed, ctx.outputRoot), code);
      for (const c of protocol.hooks.checkoutPaths(ctx.registration)) need(disjoint(fixed, await realpath(c)), code);
      let path = home;
      for (const [segment, privateMode] of protocol.policy.REGISTRY_LAYOUT) {
        path = join(path, segment);
        if (create) {
          try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
          await syncDirectory(dirname(path));
        }
        if (!create && !await exists(path)) return { absent: true };
        await safeDirectory(path, code, privateMode);
      }
      need(disjoint(path, ctx.outputRoot), code);
      for (const c of protocol.hooks.checkoutPaths(ctx.registration)) need(disjoint(path, await realpath(c)), code);
      const key = createHash("sha256").update(REGISTRY_DOMAIN).update(ctx.artifact.authorizationId).digest("hex");
      return { path, entry: join(path, key) };
    } catch { fail(code); }
  }
  function claim(ctx, identity, binding) {
    need(id(identity?.runId) && id(identity?.controllerEpoch) && Number.isSafeInteger(identity?.controller?.pid) && identity.controller.pid > 1
      && typeof identity.controller.startIdentity === "string" && identity.controller.startIdentity.length > 0
      && lookupProcessStartIdentity(identity.controller.pid) === identity.controller.startIdentity, protocol.codes.authorization_invalid);
    return { schema: protocol.policy.CONSUMPTION_SCHEMA, authorizationId: ctx.artifact.authorizationId,
      authorizationSha256: ctx.rawDigest, outputRoot: ctx.outputRoot, ...binding,
      runId: identity.runId, controllerEpoch: identity.controllerEpoch, controller: { pid: identity.controller.pid, startIdentity: identity.controller.startIdentity } };
  }
  async function pair(ctx, entry, expected) {
    const code = protocol.codes.authorization_consumption_incomplete;
    try {
      await safeDirectory(entry, code, true);
      need(same((await readdir(entry)).sort(), [CLAIM]), code);
      const a = await safeJson(join(entry, CLAIM), code), b = await safeJson(join(ctx.outputRoot, MARKER), code);
      const binding = await readLease(ctx.outputRoot, a.controller);
      need(same(a, b) && a.schema === protocol.policy.CONSUMPTION_SCHEMA && a.authorizationId === ctx.artifact.authorizationId
        && a.authorizationSha256 === ctx.rawDigest && a.outputRoot === ctx.outputRoot
        && same(a.outputIdentity, binding.outputIdentity) && same(a.leaseIdentity, binding.leaseIdentity)
        && id(a.runId) && id(a.controllerEpoch) && Number.isSafeInteger(a.controller?.pid) && a.controller.pid > 1
        && typeof a.controller.startIdentity === "string" && (!expected || same(a, expected)), code);
    } catch { fail(code); }
  }
  async function consumeAuthorization(handle, identity, lease) {
    try { return await consume(handle, identity, lease); }
    catch (error) { fail(protocol.refusalPattern.test(error?.code ?? "") ? error.code : protocol.codes.authorization_consumption_incomplete); }
  }
  async function consume(handle, identity, lease) {
    const ctx = await revalidate(handle), expected = claim(ctx, identity);
    need(identity.controller.pid === process.pid, protocol.codes.authorization_invalid);
    Object.assign(expected, await assertLease(lease, ctx.outputRoot, identity.controller));
    const r = await registry(ctx, true);
    await safeDirectory(ctx.outputRoot, protocol.codes.authorization_binding_mismatch, true);
    if (await exists(r.entry)) {
      const prior = await safeJson(join(r.entry, CLAIM), protocol.codes.authorization_consumption_incomplete);
      if (prior.schema === protocol.policy.CONSUMPTION_SCHEMA && prior.authorizationId === ctx.artifact.authorizationId
        && hash(prior.authorizationSha256) && prior.authorizationSha256 !== ctx.rawDigest) fail(protocol.codes.authorization_already_consumed);
      await pair(ctx, r.entry); fail(protocol.codes.authorization_already_consumed);
    }
    need(!await exists(join(ctx.outputRoot, MARKER)), protocol.codes.authorization_consumption_incomplete);
    need(!await exists(join(ctx.outputRoot, "units")), protocol.codes.pilot_resume_forbidden);
    // The only permitted pre-setup file is the caller's lease. No reuse of an old run root.
    need((await readdir(ctx.outputRoot)).every(name => name === "controller-lock.sqlite"), protocol.codes.pilot_resume_forbidden);
    try { await mkdir(r.entry, { mode: 0o700 }); }
    catch (e) { if (e.code === "EEXIST") fail(protocol.codes.authorization_already_consumed); throw e; }
    // Persist the burn before either marker. No rollback, repair or identical-claim replay.
    await syncDirectory(r.path);
    try {
      await durable(join(ctx.outputRoot, MARKER), expected, true);
      await durable(join(r.entry, CLAIM), expected, true);
      await pair(ctx, r.entry, expected);
    } catch { fail(protocol.codes.authorization_consumption_incomplete); }
    return Object.freeze({ consumed: true, authorizationId: ctx.artifact.authorizationId });
  }
  async function verifyConsumption(handle, identity) {
    try { return await verifyConsumedPair(handle, identity); }
    catch (error) { fail(protocol.refusalPattern.test(error?.code ?? "") ? error.code : protocol.codes.authorization_consumption_incomplete); }
  }
  async function verifyConsumedPair(handle, identity) {
    const ctx = await revalidate(handle), r = await registry(ctx, false);
    need(!r.absent && await exists(r.entry), protocol.codes.authorization_consumption_incomplete);
    await safeDirectory(ctx.outputRoot, protocol.codes.authorization_consumption_incomplete, true);
    await pair(ctx, r.entry, claim(ctx, identity, await readLease(ctx.outputRoot, identity?.controller)));
    return true;
  }
  return Object.freeze({ binds, validate, bindsRegistration, matchesAccountHandle, consumeAuthorization, verifyConsumption });
}
