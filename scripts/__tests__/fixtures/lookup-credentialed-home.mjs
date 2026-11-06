import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, relative, isAbsolute, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, threadId } from "node:worker_threads";

// Data-I/O canary, not an OS sandbox. Code resolution stays production-native.
export function credentialedHomeCanary({ root, home, credential, evidence }) {
  const originals = [], codeReads = new Set(), postReads = new Set(), descriptors = new Map();
  const nativeRealpath = fs.realpathSync.native, saveFile = fs.writeFileSync;
  root = nativeRealpath(root); home = nativeRealpath(home);
  let constructed = false, active = true;
  const stats = { threadId, canaries: 0, denied: [], credentialReads: 0, credentialWrites: 0 };
  const within = (base, path) => { const r = relative(base, path); return !r || (!r.startsWith("..") && !isAbsolute(r)); };
  const moduleCode = path => /^(?:node_modules\/|packages\/[^/]+\/(?:dist|node_modules)\/).*\.(?:js|mjs|cjs|json|node)$/u.test(path);
  function check(value, write = false) {
    if (!active) return;
    if (typeof value === "number") value = descriptors.get(value);
    if (value == null) return;
    if (value instanceof URL) value = fileURLToPath(value);
    if (!Buffer.isBuffer(value) && typeof value !== "string") return;
    const lexical = resolve(String(value));
    const denied = path => (write && within(root, path)) || (within(home, path) && (write || !within(root, path)));
    const refuse = () => { stats.denied.push({write}); throw Error("test_real_home_denied"); };
    if (denied(lexical)) refuse();
    // Existing symlinks must not turn the ROOT allowance into a home-store allowance.
    let ancestor = lexical; const tail = [];
    for (;;) {
      try { ancestor = nativeRealpath(ancestor); break; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code) || dirname(ancestor) === ancestor) throw error;
        tail.unshift(basename(ancestor)); ancestor = dirname(ancestor);
      }
    }
    const path = join(ancestor, ...tail);
    if (denied(path)) refuse();
    if (within(root, path)) {
      const name = relative(root, path).replaceAll("\\", "/");
      codeReads.add(name); if (constructed) postReads.add(name);
    }
    if (within(resolve(credential, ".."), path)) {
      if (write) { stats.credentialWrites++; throw Error("test_credential_write_denied"); }
      if (path === credential) stats.credentialReads++;
    }
  }
  const patch = (target, name, wrap) => {
    if (typeof target[name] !== "function") return;
    const original = target[name]; target[name] = wrap(original); if (name === "realpathSync") target[name].native = function (...args) { check(args[0]); return nativeRealpath(...args); }; originals.push(() => { target[name] = original; });
  };
  const writes = ["writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "chmod", "chown", "truncate", "utimes", "createWriteStream"];
  const reads = ["readFile", "readdir", "opendir", "stat", "lstat", "access", "realpath", "readlink", "createReadStream"];
  for (const target of [fs, fsp]) {
    for (const [names, write] of [[writes, true], [reads, false]]) for (const name of names) for (const suffix of target === fs ? ["", "Sync"] : [""]) {
      const method = name + suffix;
      patch(target, method, original => function (...args) {
        check(args[0], write);
        return original.apply(this, args);
      });
    }
    for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) for (const suffix of target === fs ? ["", "Sync"] : [""]) {
      patch(target, name + suffix, original => function (...args) { check(args[0], name !== "copyFile" && name !== "cp"); check(args[1], true); return original.apply(this, args); });
    }
  }
  const writable = flags => typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/u.test(flags ?? "r");
  patch(fs, "openSync", original => function (path, flags, ...args) { check(path, writable(flags)); const fd = original.call(this, path, flags, ...args); descriptors.set(fd, path); return fd; });
  patch(fs, "open", original => function (path, flags, ...args) { check(path, writable(flags)); const callback = args.pop(); return original.call(this, path, flags, ...args, (error, fd) => { if (!error) descriptors.set(fd, path); callback(error, fd); }); });
  patch(fsp, "open", original => async function (path, flags, ...args) {
    check(path, writable(flags)); const handle = await original.call(this, path, flags, ...args); descriptors.set(handle.fd, path);
    for (const method of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes"]) {
      const fn = handle[method]; handle[method] = function (...values) { check(path, true); return fn.apply(this, values); };
    }
    for (const method of ["read", "readv", "readFile", "readLines", "createReadStream"]) {
      const fn = handle[method]; if (typeof fn === "function") handle[method] = function (...values) { check(path); return fn.apply(this, values); };
    }
    return handle;
  });
  for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) for (const suffix of ["", "Sync"]) patch(fs, name + suffix, original => function (...args) { check(args[0], true); return original.apply(this, args); });
  for (const name of ["read", "readv"]) for (const suffix of ["", "Sync"]) patch(fs, name + suffix, original => function (...args) { check(args[0]); return original.apply(this, args); });
  syncBuiltinESMExports();
  const result = () => ({ ...stats, codeReads: [...codeReads].sort(), constructed, postConstructionReads: [...postReads].sort(), nonModuleReads: [...postReads].filter(path => !moduleCode(path)).sort() });
  return {
    constructed() { constructed = true; }, result,
    canaries() {
      for (const probe of [() => fs.readFileSync(join(home, ".pi", "auth.json")), () => fs.writeFileSync(join(home, ".lookup-write-canary"), "fictional"), () => fs.mkdirSync(join(root, ".lookup-write-canary"))]) {
        try { probe(); throw Error("test_canary_bypassed"); } catch (error) { if (error.message !== "test_real_home_denied") throw error; stats.canaries++; }
      }
      stats.denied.length = 0;
    },
    save() { saveFile(join(evidence, `home-${threadId}.json`), JSON.stringify(result())); },
    restore() { active = false; for (const undo of originals.reverse()) undo(); syncBuiltinESMExports(); },
  };
}

if (!isMainThread) {
  const encoded = new URL(import.meta.url).searchParams.get("canary");
  if (encoded) {
    const guard = credentialedHomeCanary(JSON.parse(Buffer.from(encoded, "base64url").toString()));
    guard.canaries(); guard.constructed();
    const post = parentPort.postMessage;
    parentPort.postMessage = function (...args) { guard.save(); return post.apply(this, args); };
    process.on("exit", () => guard.save());
  }
}
