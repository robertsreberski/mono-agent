import fs from "node:fs";
import child from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import workers from "node:worker_threads";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentialedHomeCanary } from "./lookup-credentialed-home.mjs";

// Observation only. Never substitutes an entrypoint, response, serializer or identity.
export function installLookupProofScope(policy) {
  const nativeRealpath = fs.realpathSync.native, originals = [], allowed = [], refused = [], refusedInvocations = [], databases = [];
  let spawning = 0;
  const files = credentialedHomeCanary(policy), ports = new Set((policy.origins ?? []).map(origin => new URL(origin).port));
  const within = (base, path) => { const r = relative(base, path); return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r)); };
  const patch = (object, name, wrapper) => { if (typeof object[name] !== "function") return; const fn = object[name]; object[name] = wrapper(fn); originals.push(() => {object[name] = fn;}); };
  const deny = family => { refused.push(family); throw Error(`test_${family}_denied`); };
  const executable = (name, env) => {
    if (isAbsolute(name)) {try {return nativeRealpath(name);} catch(error) {if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error;}}
    for (const path of (env.PATH ?? "").split(":")) try { return nativeRealpath(join(path, name)); } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    return null;
  };
  const node = nativeRealpath(process.execPath), ps = nativeRealpath("/bin/ps");
  const sysctl = process.platform === "darwin" ? nativeRealpath("/usr/sbin/sysctl") : null;
  const git = policy.mode === "configured" ? executable("git", process.env) : null;
  function invocation(command, args, options = {}, family) {
    if (!Array.isArray(args) || options.shell) return deny("subprocess");
    const env = {...(options.env ?? process.env)};
    // Production POSIX identity uses PATH/LANG/LC_ALL/TZ only. Add the approved
    // test HOME without replacing its locale, and retain per-role fork homes.
    if (!Object.hasOwn(env, "HOME")) env.HOME = policy.testHome;
    if (env.HOME !== policy.testHome && !(policy.mode === "configured" && family === "fork" && within(policy.ownedRoot, env.HOME ?? "/"))) return deny("subprocess");
    const binary = executable(command, env), same = expected => JSON.stringify(args) === JSON.stringify(expected);
    let kind;
    if (binary === ps && args.length === 4 && args[0] === "-p" && /^[1-9]\d*$/u.test(args[1]) && args[2] === "-o" && args[3] === "lstart=") kind = "identity";
    if (binary === sysctl && same(["-n", "kern.bootsessionuuid"])) kind = "identity";
    if (binary === sysctl && same(["-n", "kern.boottime"]) && new Error().stack.includes("/packages/conversation/dist/process-incarnation.js")) kind = "legacy-identity";
    // Legacy identity is allowed only from the actual production identity module.
    if (policy.mode === "configured") {
      if (binary === ps && (same(["-axo", "pid=,pgid=,lstart=,stat="]) || same(["-axo", "pid=,pgid=,stat="]))) kind = "group";
      if (binary === node && args.length === 2 && args[1] === "--lookup-protocol" && policy.codeRoots?.some(root => args[0] === join(root, "scripts/continuity-benchmark.mjs"))) kind = "protocol";
      if (binary === git) {
        const root = args[2], prefix = ["--no-optional-locks", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
        const tail = args.slice(prefix.length), fixed = [["rev-parse", "HEAD"], ["rev-parse", "--show-toplevel"], ["status", "--porcelain=v1"], ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], ["ls-files", "-v", "-z"], ["ls-tree", "-rz", "--full-tree", "HEAD"], ["show", "HEAD:packages/conversation/src/continuity/render-fit.ts"]];
        if (policy.codeRoots?.includes(root) && JSON.stringify(args.slice(0, prefix.length)) === JSON.stringify(prefix) && fixed.some(x => JSON.stringify(x) === JSON.stringify(tail)) && env.GIT_CONFIG_GLOBAL === "/dev/null" && env.GIT_CONFIG_NOSYSTEM === "1") kind = "git";
        const legacy = [["rev-parse", "HEAD"], ["status", "--porcelain", "--untracked-files=all"], ["ls-files", "-z", "--", "scripts/continuity-*", "scripts/lib/continuity-*", "scripts/holdout-validate.mjs", "scripts/fixtures/continuity/", "scripts/fixtures/continuity-*", "packages/contracts/src/upkeep-accounting.ts", "packages/conversation/src/continuity/ledger.ts", "packages/conversation/src/continuity/ranking.ts"]];
        if (policy.codeRoots?.some(root => legacy.some(tail => same(["-C", `${root}/`, ...tail]))) && env.GIT_CONFIG_GLOBAL === "/dev/null" && env.GIT_CONFIG_NOSYSTEM === "1") kind = "git";
      }
      if (family === "fork" && policy.forkPaths?.includes(resolve(command)) && args.length === 0 && options.detached === true
        && options.cwd === resolve(command, "../../..") && JSON.stringify(options.stdio) === JSON.stringify(["ignore", "ignore", "pipe", "ipc"])
        && ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].every(key => env[key] === env.HOME)
        && env.GIT_CONFIG_GLOBAL === "/dev/null" && env.GIT_CONFIG_NOSYSTEM === "1") kind = "fork";
    }
    if (!kind) {if (policy.mode === "configured") refusedInvocations.push({command, args, family}); return deny("subprocess");}
    const argv = kind === "identity" && args[0] === "-p" ? ["-p", "<pid>", ...args.slice(2)] : args;
    const row = {pid: process.pid, threadId: workers.threadId, executable: kind === "fork" ? node : binary, argv: kind === "fork" ? [resolve(command), ...args] : argv, family, kind, shell: false, home: env.HOME, count: 1, environmentKeys: Object.keys(env).sort(),
      ...(["git", "fork"].includes(kind) ? {globalConfig: env.GIT_CONFIG_GLOBAL, systemConfig: "disabled"} : {})};
    const previous = allowed.find(x => JSON.stringify({...x, count: 1}) === JSON.stringify(row));
    if (previous) previous.count++; else allowed.push(row);
    return {kind, record: previous ?? row, options: {...options, env, shell: false}};
  }
  const preload = (overrides = {}) => { const url = new URL(policy.preloadUrl ?? import.meta.url); url.searchParams.set("policy", Buffer.from(JSON.stringify({...policy, ...overrides, origins: [...ports].map(port => `http://127.0.0.1:${port}`)})).toString("base64url")); return url.href; };
  const imports = (args, extra) => { const result = []; for (let i = 0; i < args.length; i++) { const arg = args[i], value = arg === "--import" ? args[i + 1] : arg.startsWith("--import=") ? arg.slice(9) : null; if (value && /lookup-(?:proof-scope|configured-preload)\.mjs/u.test(value)) {if (arg === "--import") i++; continue;} result.push(arg); } return [...result, "--import", preload(extra)]; };
  for (const family of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) patch(child, family, original => function (command, args = [], options = {}, callback) {
    if (typeof options === "function") {callback = options; options = {};}
    const call = invocation(command, args, options, family);
    if (call.kind === "protocol") {args = ["--import", preload({role: "verification"}), ...args]; call.record.actualArgv = args;}
    if (family === "fork") {
      const role = command.endsWith("continuity-lookup-preparation-child.mjs") ? "preparation" : "probe";
      policy.onFork?.({command, args, options: call.options, role});
      call.options.execArgv = imports(options.execArgv ?? process.execArgv, {testHome: call.options.env.HOME, role});
      call.record.actualArgv = [...call.options.execArgv, resolve(command), ...args];
    }
    spawning++;
    try {return callback ? original.call(this, command, args, call.options, callback) : original.call(this, command, args, call.options);}
    finally {spawning--;}
  });
  patch(child.ChildProcess.prototype, "spawn", original => function (...args) {if (!spawning) return deny("subprocess"); return original.apply(this, args);});
  for (const family of ["exec", "execSync"]) patch(child, family, () => function () {return deny("subprocess");});
  function connection(args) {
    let options = args[0]; if (Array.isArray(options)) options = options[0];
    if (typeof options === "number") options = {port: options, host: typeof args[1] === "string" ? args[1] : "localhost"};
    if (options?.host !== "127.0.0.1" || !ports.has(String(options.port))) deny("egress");
  }
  patch(net.Socket.prototype, "connect", original => function (...args) {connection(args); return original.apply(this, args);});
  patch(tls, "connect", original => function (...args) {connection(args); return original.apply(this, args);});
  patch(net.Server.prototype, "listen", original => function (...args) {
    const options = typeof args[0] === "object" ? args[0] : {port: args[0], host: args[1]};
    if (options.host !== "127.0.0.1" || !Number.isInteger(options.port) || options.port < 0) return deny("listen");
    this.prependOnceListener("listening", () => {const address = this.address(); if (address.address !== "127.0.0.1") deny("listen"); ports.add(String(address.port));});
    return original.apply(this, args);
  });
  patch(dgram.Socket.prototype, "send", () => function () {return deny("egress");});
  for (const target of [dns, dns.promises]) for (const method of Object.keys(target)) if (/^(lookup|resolve|reverse)/u.test(method)) patch(target, method, original => function (...args) {
    // Node's Server.listen calls lookup even for a numeric address; no resolver
    // or network is involved in this exact literal-IP lookup.
    if (method === "lookup" && args[0] === "127.0.0.1") return original.apply(this, args);
    return deny("egress");
  });
  const oldWebSocket = globalThis.WebSocket; globalThis.WebSocket = class {constructor() {deny("egress");}}; originals.push(() => {globalThis.WebSocket = oldWebSocket;});
  // SQLite/native operations bypass fs wrappers. Assert every actual connection's path,
  // but do not claim to sandbox SQL ATTACH, native bindings or internal loader I/O.
  const require = createRequire(import.meta.url), sqlite = require("node:sqlite"), Database = sqlite.DatabaseSync;
  sqlite.DatabaseSync = class extends Database {
    constructor(path, ...args) {
      if (path !== ":memory:") {
        const resolved = resolve(path instanceof URL ? fileURLToPath(path) : path), canonical = files.check(resolved, true);
        if (!within(policy.ownedRoot, canonical)) throw Error("test_sqlite_path_denied"); if (!databases.includes(resolved)) databases.push(resolved);
      }
      super(path, ...args);
    }
  };
  originals.push(() => {sqlite.DatabaseSync = Database;});
  patch(workers, "Worker", NativeWorker => class extends NativeWorker {
    constructor(entry, options = {}) {
      // Each level installs this same wrapper; nested threads cannot drop the preload.
      super(entry, {...options, execArgv: imports(options.execArgv ?? process.execArgv, policy.mode === "configured" ? {role: "worker", parentRole: policy.role} : {})});
    }
  });
  syncBuiltinESMExports();
  const result = () => ({subprocesses: allowed, unexpected: [...refused], refusedInvocations, databases: [...databases], networkPorts: [...ports].sort()});
  return {
    files, result, ownsOrigin: origin => {const url = new URL(origin); return url.protocol === "http:" && url.hostname === "127.0.0.1" && ports.has(url.port);},
    canaries() {
      const families = [() => child.spawn("/bin/echo", ["denied"]), () => child.spawnSync("/bin/echo", ["denied"]), () => child.exec("echo denied"), () => child.execSync("echo denied"), () => child.execFile("/bin/echo", ["denied"]), () => child.execFileSync("/bin/echo", ["denied"]), () => child.fork("/fictional/denied.mjs"), () => child.spawn("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {shell: true})];
      for (const probe of families) {try {probe(); throw Error("test_canary_bypassed");} catch (error) {if (error.message !== "test_subprocess_denied") throw error;}}
      try {new net.Socket().connect({host: "203.0.113.1", port: 443}); throw Error("test_canary_bypassed");} catch (error) {if (error.message !== "test_egress_denied") throw error;}
      refused.length = 0; refusedInvocations.length = 0; files.canaries(); return families.length + 1;
    },
    save(extra = {}) {files.save({...result(), ...extra});},
    restore() {for (const undo of originals.reverse()) undo(); files.restore(); syncBuiltinESMExports();},
  };
}

const encoded = new URL(import.meta.url).searchParams.get("policy");
if (encoded) {
  const policy = JSON.parse(Buffer.from(encoded, "base64url").toString()), scope = installLookupProofScope(policy);
  const probes = scope.canaries();
  globalThis[Symbol.for("lookup.proof.scope")] = scope;
  if (!workers.isMainThread) {
    scope.files.constructed(); const post = workers.parentPort.postMessage;
    workers.parentPort.postMessage = function (...args) {scope.save({processCanaries: probes}); return post.apply(this, args);};
  }
  process.on("exit", () => scope.save({processCanaries: probes}));
}
