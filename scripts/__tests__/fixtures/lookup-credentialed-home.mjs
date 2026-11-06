import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, relative, isAbsolute, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";

// JavaScript filesystem-API canary, not an OS/native-I/O sandbox.
export function credentialedHomeCanary({ root, home, credential, evidence }) {
  const originals = [], codeReads = new Set(), postReads = new Set(), postOperations = new Map(), descriptors = new Map(), apis = [];
  const nativeRealpath = fs.realpathSync.native, saveFile = fs.writeFileSync, rename = fs.renameSync;
  root = nativeRealpath(root); home = nativeRealpath(home);
  let constructed = false, active = true;
  const stats = { pid: process.pid, threadId, canaries: 0, denied: [], credentialReads: 0, credentialWrites: 0 };
  const within = (base, path) => { const r = relative(base, path); return !r || (r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(r)); };
  const moduleCode = path => /^(?:node_modules\/|packages\/[^/]+\/(?:dist|node_modules)\/).*\.(?:js|mjs|cjs|json|node)$/u.test(path) || /^scripts\/lib\/.*\.mjs$/u.test(path);
  function check(value, write = false, api = "descriptor") {
    if (!active) return;
    if (typeof value === "number") value = descriptors.get(value);
    if (value == null) return;
    if (value instanceof URL) value = fileURLToPath(value);
    if (!Buffer.isBuffer(value) && typeof value !== "string") return;
    const lexical = resolve(String(value));
    const denied = path => (write && within(root, path)) || (within(home, path) && (write || !within(root, path)));
    const refuse = () => { stats.denied.push({write}); throw Error("test_real_home_denied"); };
    if (denied(lexical)) refuse();
    // Canonicalize missing targets too: an outside alias must not bypass home denial.
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
      codeReads.add(name); if (constructed) {
        postReads.add(name); postOperations.set(`${api}:${name}`, {api, path: name});
        if (!write && !moduleCode(name)) throw Error("test_root_data_read_denied");
      }
    }
    if (credential && within(resolve(credential, ".."), path)) {
      if (write) { stats.credentialWrites++; throw Error("test_credential_write_denied"); }
      if (path === credential) stats.credentialReads++;
    }
    return path;
  }
  const patch = (target, name, wrap) => {
    if (typeof target[name] !== "function") return;
    const original = target[name]; target[name] = wrap(original);
    apis.push(`${target === fs ? "fs" : "fsp"}.${name}`);
    if (typeof original.native === "function") {
      target[name].native = function (...args) { check(args[0], false, `${name}.native`); return original.native.apply(this, args); };
      apis.push(`fs.${name}.native`);
    }
    originals.push(() => { target[name] = original; });
  };
  const writes = ["writeFile", "appendFile", "mkdir", "mkdtemp", "mkdtempDisposable", "rm", "rmdir", "unlink", "chmod", "chown", "lchmod", "lchown", "truncate", "utimes", "lutimes", "createWriteStream"];
  const reads = ["readFile", "readdir", "opendir", "stat", "lstat", "statfs", "access", "exists", "realpath", "readlink", "openAsBlob", "watch", "watchFile", "unwatchFile", "createReadStream"];
  for (const target of [fs, fsp]) {
    for (const [names, write] of [[writes, true], [reads, false]]) for (const name of names) for (const suffix of target === fs ? ["", "Sync"] : [""]) {
      patch(target, name + suffix, original => function (...args) {
        check(args[0], write, name + suffix);
        if (name.startsWith("create") && args[1]?.fd != null) check(args[1].fd, write);
        return original.apply(this, args);
      });
    }
    for (const suffix of target === fs ? ["", "Sync"] : [""]) patch(target, "glob" + suffix, original => function (patterns, options, ...args) {
      const cwd = options?.cwd instanceof URL ? fileURLToPath(options.cwd) : options?.cwd ?? process.cwd();
      check(cwd); for (const pattern of [patterns].flat()) check(resolve(cwd, pattern));
      return original.call(this, patterns, options, ...args);
    });
    for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) for (const suffix of target === fs ? ["", "Sync"] : [""]) {
      patch(target, name + suffix, original => function (...args) {
        check(args[1], true);
        check(name === "symlink" && !isAbsolute(String(args[0])) ? resolve(dirname(String(args[1])), String(args[0])) : args[0], name !== "copyFile" && name !== "cp");
        return original.apply(this, args);
      });
    }
  }
  const writable = flags => typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/u.test(flags ?? "r");
  patch(fs, "openSync", original => function (path, flags, ...args) { check(path, writable(flags)); const fd = original.call(this, path, flags, ...args); descriptors.set(fd, path); return fd; });
  patch(fs, "open", original => function (path, flags, ...args) { check(path, writable(flags)); const callback = args.pop(); return original.call(this, path, flags, ...args, (error, fd) => { if (!error) descriptors.set(fd, path); callback(error, fd); }); });
  patch(fs, "closeSync", original => function (fd) { const result = original.call(this, fd); descriptors.delete(fd); return result; });
  patch(fs, "close", original => function (fd, callback) { return original.call(this, fd, error => { if (!error) descriptors.delete(fd); callback(error); }); });
  patch(fsp, "open", original => async function (path, flags, ...args) {
    check(path, writable(flags)); const handle = await original.call(this, path, flags, ...args); descriptors.set(handle.fd, path);
    for (const [methods, write] of [[["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes", "createWriteStream"], true], [["read", "readv", "readFile", "readLines", "createReadStream", "readableWebStream", "stat"], false]]) for (const method of methods) {
      const fn = handle[method]; if (typeof fn === "function") handle[method] = function (...values) { check(path, write); return fn.apply(this, values); };
    }
    const close = handle.close, fd = handle.fd;
    handle.close = async function (...args) { const value = await close.apply(this, args); descriptors.delete(fd); return value; };
    return handle;
  });
  for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) for (const suffix of ["", "Sync"]) patch(fs, name + suffix, original => function (...args) { check(args[0], true); return original.apply(this, args); });
  for (const name of ["read", "readv", "fstat"]) for (const suffix of ["", "Sync"]) patch(fs, name + suffix, original => function (...args) { check(args[0]); return original.apply(this, args); });
  syncBuiltinESMExports();
  const result = () => ({ ...stats, apis, postConstructionOperations: [...postOperations.values()], scriptCodeAccesses: [...postOperations.values()].filter(row => row.path.startsWith("scripts/lib/")), codeReads: [...codeReads].sort(), constructed, postConstructionReads: [...postReads].sort(), nonModuleReads: [...postReads].filter(path => !moduleCode(path)).sort() });
  return {
    check, constructed() { constructed = true; }, result,
    canaries() {
      for (const probe of [() => fs.readFileSync(join(home, ".pi", "auth.json")), () => fs.existsSync(join(home, ".pi", "auth.json")), () => fs.writeFileSync(join(home, ".lookup-write-canary"), "fictional"), () => fs.mkdirSync(join(root, ".lookup-write-canary"))]) {
        try { probe(); throw Error("test_canary_bypassed"); } catch (error) { if (error.message !== "test_real_home_denied") throw error; stats.canaries++; }
      }
      stats.denied.length = 0;
    },
    save(extra = {}) {
      const path = join(evidence, `home-${process.pid}-${threadId}.json`), temporary = `${path}.tmp`;
      check(path, true); saveFile(temporary, JSON.stringify({...result(), ...extra}), {mode: 0o600}); rename(temporary, path);
    },
    restore() { active = false; for (const undo of originals.reverse()) undo(); syncBuiltinESMExports(); },
  };
}
