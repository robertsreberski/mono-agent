import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rebuild = "run pnpm --filter @mono-agent/turn build";
let activeChild;
const selfIdentity = `self:${randomUUID()}`;

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing staged symlink: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export function ownedPaths(directory = packageDirectory) {
  return readFileSync(resolve(directory, ".gitignore"), "utf8").split("\n")
    .filter((line) => line.startsWith("/src/"))
    .map((line) => {
      if (!/^\/src\/(?:[\w-]+\/)*[\w-]+\.(?:d\.ts|js(?:\.map)?)$/u.test(line)) {
        throw new Error(`Invalid staged product: ${line}`);
      }
      return line.slice(1);
    });
}

const statePath = (directory) => resolve(directory, "node_modules/.cache/staged-build.json");
const compilerPath = (directory, path) => resolve(directory, path.replace(/^src\//u, "dist/"));
const readState = (directory) => existsSync(statePath(directory)) ? JSON.parse(readFileSync(statePath(directory), "utf8")) : null;
function writeState(directory, state) {
  mkdirSync(dirname(statePath(directory)), { recursive: true });
  writeFileSync(`${statePath(directory)}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${statePath(directory)}.tmp`, statePath(directory));
}
function sourceDigest(directory, owned) {
  const hash = createHash("sha256");
  const inputs = ["package.json", ".gitignore", "tsconfig.build.json", "tsconfig.json", "tsconfig.test.json", "scripts/staged-build.mjs"]
    .map((path) => resolve(directory, path)).filter(existsSync);
  inputs.push(...files(resolve(directory, "src")).filter((path) => !path.includes("/__tests__/")
    && !owned.includes(relative(directory, path)) && /\.(?:ts|js|mjs)$/u.test(path)));
  for (const path of inputs.sort()) hash.update(relative(directory, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex");
}
function same(path, hash) {
  return existsSync(path) && lstatSync(path).isFile() && digest(readFileSync(path)) === hash;
}

function cleanOverlays(directory, owned) {
  let state = readState(directory);
  const lostState = !state;
  let error;
  for (const path of Object.keys(state?.overlays ?? {})) {
    if (!owned.includes(path)) error ??= new Error(`Unregistered source overlay: ${path}; restore its inventory entry before cleanup.`);
  }
  for (const path of owned.filter((name) => name.endsWith(".d.ts"))) {
    const target = resolve(directory, path);
    if (!existsSync(target)) { if (state?.overlays) delete state.overlays[path]; continue; }
    let expected = state?.overlays?.[path] ?? state?.products?.[path];
    const compiled = compilerPath(directory, path);
    if (!expected && lostState && existsSync(compiled) && untracked(directory, path)
      && same(target, digest(readFileSync(compiled)))) {
      expected = digest(readFileSync(compiled));
      state ??= { products: {}, overlays: {}, hidden: [] };
      state.overlays[path] = expected;
      writeState(directory, state);
    }
    if (!expected || !same(target, expected)) {
      error ??= new Error(`Refusing to remove unowned or modified overlay: ${path}`);
      continue; // Still clean all other owned overlays, preserving the first failure.
    }
    rmSync(target);
    if (state?.overlays) delete state.overlays[path];
  }
  if (state) {
    state.products = Object.fromEntries(Object.entries(state.products).filter(([path]) => !path.endsWith(".d.ts")));
    writeState(directory, state);
  }
  if (error) throw error;
  return state;
}

function untracked(directory, path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: directory, stdio: "ignore" });
  return result.status === 1;
}
function validateProducts(directory, owned, state, requireFresh = false) {
  state ??= { products: {}, overlays: {}, hidden: [] };
  for (const path of Object.keys(state.products)) {
    if (!owned.includes(path)) throw new Error(`Unregistered staged product: ${path}`);
  }
  for (const path of owned.filter((name) => !name.endsWith(".d.ts"))) {
    const target = resolve(directory, path), compiled = compilerPath(directory, path);
    // Cache eviction is not ownership loss if both the inventory and git agree,
    // and an independently retained compiler copy proves the bytes.
    if (!state.products[path] && existsSync(compiled) && untracked(directory, path)
      && existsSync(target) && same(target, digest(readFileSync(compiled)))) {
      state.products[path] = digest(readFileSync(compiled));
      writeState(directory, state);
    }
    if (!existsSync(target) && state.products[path]) {
      if (!same(compiled, state.products[path])) throw new Error(`Stale compiler product: ${path}; ${rebuild}.`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(compiled));
    }
    if (existsSync(target) && (!state.products[path] || !same(target, state.products[path]))) {
      throw new Error(`Refusing to overwrite unowned or modified staged product: ${path}. Inspect this file; if confirmed generated, delete ${path}, then ${rebuild}.`);
    }
  }
  state.hidden = [];
  if (Object.keys(state.products).length || readState(directory)) writeState(directory, state);
  if (requireFresh && state.sourceDigest !== sourceDigest(directory, owned)) {
    throw new Error(`Staged outputs are stale; ${rebuild} before typechecking or parity.`);
  }
  return state;
}

function rollback(directory, state) {
  const tx = state.transaction;
  if (!tx) return;
  // A transaction record is only accepted for our fixed, package-local staging
  // directory. Never follow paths supplied by a damaged ownership record.
  const stage = resolve(directory, "node_modules/.cache/staged-build-work");
  for (const name of ["dist", "types"]) {
    const backup = resolve(stage, "previous", name), target = resolve(directory, name);
    if (existsSync(backup)) { rmSync(target, { recursive: true, force: true }); renameSync(backup, target); }
    else if (!tx.had[name]) rmSync(target, { recursive: true, force: true });
  }
  for (const [path, hash] of Object.entries({ ...tx.previous.products, ...state.products })) {
    if (!ownedPaths(directory).includes(path)) throw new Error(`Unregistered staged product: ${path}`);
    const target = resolve(directory, path), before = tx.previous.products[path];
    if (existsSync(target) && !same(target, hash) && !(before && same(target, before))) {
      throw new Error(`Refusing rollback over modified product: ${path}`);
    }
    if (before) {
      const backup = resolve(stage, "previous", path);
      if (!same(backup, before)) throw new Error(`Missing rollback product: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(backup));
    } else rmSync(target, { force: true });
  }
  writeState(directory, tx.previous);
}
function prepare(directory, owned) {
  const state = readState(directory);
  if (state?.transaction) rollback(directory, state);
  return validateProducts(directory, owned, cleanOverlays(directory, owned));
}

// Keep synchronous callers (scanner policy and fake compilers) synchronous, but
// await real child processes so signals can interrupt them and unwind finally.
function settle(result, cleanup) {
  if (result?.then) return result.finally(cleanup);
  cleanup();
  return result;
}
function drive(iterator) {
  function next(method, value) {
    let step = iterator[method](value);
    while (!step.done) {
      if (step.value?.then) return step.value.then((value) => next("next", value), (error) => next("throw", error));
      step = iterator.next(step.value);
    }
    return step.value;
  }
  return next("next");
}
function processStart(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error?.code === "ENOENT") {
    // Linux exposes a boot-scoped start tick even on minimal images without ps.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tick = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (tick && /^\d+$/u.test(tick) && boot) return `proc:${boot}:${tick}`;
    } catch (error) { if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error; }
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return null;
      if (error.code !== "EPERM") throw error;
    }
    // A per-process nonce identifies our own incarnation. Other live processes
    // cannot safely be distinguished without OS birth evidence: refuse takeover.
    return pid === process.pid ? selfIdentity : "unverified-live";
  }
  if (result.error) throw result.error;
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return null; throw error; }
  throw new Error("Cannot verify staged-build lock process start time");
}
function lock(directory, action) {
  const path = resolve(directory, "node_modules/.cache/staged-build.lock");
  mkdirSync(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, start: processStart(process.pid) });
  try { symlinkSync(owner, path); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raw = readlinkSync(path), previous = /^\d+$/u.test(raw) ? { pid: Number(raw) } : JSON.parse(raw);
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error("Invalid staged-build lock owner");
    const start = processStart(previous.pid);
    const kind = (value) => value?.startsWith("proc:") ? "proc" : value?.startsWith("self:") ? "self" : value === "unverified-live" ? "unknown" : "ps";
    if (start && (!previous.start || start === previous.start || kind(start) !== kind(previous.start) || kind(start) === "unknown")) {
      throw new Error(`Staged build is already active or its live owner cannot be disproved (PID ${previous.pid})`);
    }
    rmSync(path);
    symlinkSync(owner, path);
  }
  let interrupted;
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal, index) => {
    const listener = () => {
      interrupted = new Error(`Staged operation interrupted by ${signal}`);
      process.exitCode = [130, 143, 129][index];
      activeChild?.kill(signal);
    };
    process.on(signal, listener);
    return [signal, listener];
  });
  const release = () => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    rmSync(path, { force: true });
  };
  try {
    const result = action();
    if (result?.then) return result.then((value) => { if (interrupted) throw interrupted; return value; }).finally(release);
    if (interrupted) throw interrupted;
    release();
    return result;
  } catch (error) { release(); throw error; }
}

export function runCommand(command, args, directory) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: directory, stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (status === 0) accept(0);
      else reject(new Error(`Staged command failed (${status ?? signal}): ${command}`));
    });
  });
}
const run = (args, directory) => runCommand(process.execPath, args, directory);

function* checkGraphs(directory, owned, state, execute, compiled = resolve(directory, "dist"), projects = ["tsconfig.json", "tsconfig.test.json"]) {
  const overlays = {};
  for (const path of owned.filter((name) => name.endsWith(".d.ts"))) {
    const output = resolve(compiled, path.slice(4));
    if (!existsSync(output) || existsSync(resolve(directory, path.replace(/\.d\.ts$/u, ".ts")))) continue;
    overlays[path] = digest(readFileSync(output));
  }
  state.overlays = overlays;
  writeState(directory, state); // Publish BEFORE creating any overlay.
  let primary;
  try {
    for (const path of Object.keys(overlays)) {
      const target = resolve(directory, path);
      if (existsSync(target)) throw new Error(`Overlay collision: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(resolve(compiled, path.slice(4))));
    }
    const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    for (const project of projects) yield execute([compiler, "-p", project], directory);
    const strict = resolve(directory, "node_modules/.cache/staged-strict-declarations");
    rmSync(strict, { recursive: true, force: true });
    yield execute([compiler, "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--declarationMap", "false", "--sourceMap", "false",
      "--outDir", strict, "--declarationDir", strict, "-p", projects[0]], directory);
    for (const path of files(resolve(directory, "src")).filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.includes("/__tests__/"))) {
      const name = relative(resolve(directory, "src"), path).replace(/\.ts$/u, ".d.ts");
      const normalize = (path) => readFileSync(path, "utf8").replace(/^\/\/# sourceMappingURL=.*$/mu, "").trim();
      if (normalize(resolve(strict, name)) !== normalize(resolve(compiled, name))) {
        throw new Error(`Strict declaration mismatch: ${name}. Annotate exported TS contracts so strict and production declarations agree.`);
      }
    }
  } catch (error) { primary = error; throw error; } finally {
    try { cleanOverlays(directory, owned); } catch (error) {
      if (!primary) throw error;
      primary.message += `; cleanup: ${error.message}`;
    }
  }
}

export function assertFresh(directory = packageDirectory) {
  return lock(directory, () => validateProducts(directory, ownedPaths(directory), prepare(directory, ownedPaths(directory)), true));
}
export function typecheck(directory = packageDirectory, execute = run) {
  return lock(directory, () => {
    const owned = ownedPaths(directory), state = prepare(directory, owned);
    validateProducts(directory, owned, state, true);
    return drive(checkGraphs(directory, owned, state, execute));
  });
}
export function withSourceView(action, directory = packageDirectory) {
  return lock(directory, () => {
    const owned = ownedPaths(directory), state = prepare(directory, owned);
    for (const [path, hash] of Object.entries(state.products)) {
      if (!same(compilerPath(directory, path), hash)) throw new Error(`Stale compiler product: ${path}; ${rebuild}.`);
    }
    state.hidden = Object.keys(state.products);
    if (state.hidden.length) writeState(directory, state); // Durable before hiding.
    for (const path of state.hidden) rmSync(resolve(directory, path));
    const restore = () => validateProducts(directory, owned, state);
    try { return settle(action(), restore); } catch (error) { restore(); throw error; }
  });
}

function stagedProjects(directory, stage) {
  const config = JSON.parse(readFileSync(resolve(directory, "tsconfig.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const paths = Object.fromEntries(Object.entries(config.compilerOptions?.paths ?? {}).map(([key, targets]) => [key, targets.map((path) => resolve(directory, path))]));
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    paths[key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`] = [resolve(stage, "dist", value.types.replace(/^\.\/(?:types|dist)\//u, ""))];
  }
  return ["tsconfig.json", "tsconfig.test.json"].map((name) => {
    const path = resolve(stage, name);
    writeFileSync(path, JSON.stringify({ extends: resolve(directory, name), compilerOptions: { paths } }));
    return path;
  });
}
export function build(directory = packageDirectory, execute = run) {
  return lock(directory, () => drive((function* () {
    const owned = ownedPaths(directory), before = prepare(directory, owned);
    const stage = resolve(directory, "node_modules/.cache/staged-build-work");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    const compiled = resolve(stage, "dist"), products = {}, snapshot = sourceDigest(directory, owned);
    try {
      const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      yield execute([compiler, "--outDir", compiled, "-p", "tsconfig.build.json"], directory);
      // tsc emitted beneath the staging directory. Relocate only map source
      // paths for their final directory; executable/declaration bytes stay intact.
      for (const path of files(compiled).filter((path) => path.endsWith(".map"))) {
        const map = JSON.parse(readFileSync(path, "utf8"));
        const final = resolve(directory, "dist", relative(compiled, path));
        map.sources = map.sources.map((source) => relative(dirname(final), resolve(dirname(path), source)).replaceAll("\\", "/"));
        writeFileSync(path, JSON.stringify(map));
      }
      for (const path of files(compiled)) {
        const name = relative(compiled, path);
        if (/\.d\.(?:ts|mts)(?:\.map)?$/u.test(name)) {
          const target = resolve(stage, "types", name);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, readFileSync(path));
        }
        if (!/\.js(?:\.map)?$/u.test(name) || name.startsWith("host/")
          || !existsSync(resolve(directory, "src", name.replace(/\.js(?:\.map)?$/u, ".ts")))) continue;
        const product = `src/${name}`;
        if (!owned.includes(product)) throw new Error(`Unregistered compiler product: ${product}`);
        products[product] = digest(readFileSync(path));
      }
      const runner = "host/sandbox/srt-embed-runner.mjs";
      mkdirSync(dirname(resolve(compiled, runner)), { recursive: true });
      writeFileSync(resolve(compiled, runner), readFileSync(resolve(directory, "src", runner)));
      yield* checkGraphs(directory, owned, before, execute, compiled, stagedProjects(directory, stage));
      if (snapshot !== sourceDigest(directory, owned)) throw new Error(`Sources changed during staged build; ${rebuild}.`);
      // All compiler/checker work succeeded. Journal the small publication phase
      // before any rename/write, with complete rollback copies of old products.
      const previous = { ...before, products: { ...before.products }, overlays: {}, hidden: [] };
      for (const path of Object.keys(previous.products)) {
        const target = resolve(stage, "previous", path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(resolve(directory, path), target);
      }
      const next = { sourceDigest: snapshot, products, overlays: {}, hidden: [],
        transaction: { previous, had: Object.fromEntries(["dist", "types"].map((name) => [name, existsSync(resolve(directory, name))])) } };
      writeState(directory, next);
      for (const name of ["dist", "types"]) {
        mkdirSync(resolve(stage, "previous"), { recursive: true });
        if (next.transaction.had[name]) renameSync(resolve(directory, name), resolve(stage, "previous", name));
        renameSync(resolve(stage, name), resolve(directory, name));
      }
      // Ownership is already durable, even if a write is interrupted.
      for (const path of Object.keys(products)) {
        mkdirSync(dirname(resolve(directory, path)), { recursive: true });
        writeFileSync(resolve(directory, path), readFileSync(compilerPath(directory, path)));
      }
      for (const path of Object.keys(previous.products)) if (!products[path]) rmSync(resolve(directory, path));
      delete next.transaction;
      writeState(directory, next);
      return products;
    } catch (error) {
      const state = readState(directory);
      if (state?.transaction) {
        try { rollback(directory, state); } catch (recovery) {
          error.message += `; rollback incomplete (backup retained): ${recovery.message}`;
        }
      }
      throw error;
    } finally {
      if (!readState(directory)?.transaction) rmSync(stage, { recursive: true, force: true });
    }
  })()));
}

export async function verifyInstalled(directory = packageDirectory) {
  if (existsSync(resolve(directory, ".gitignore"))) {
    lock(directory, () => prepare(directory, ownedPaths(directory)));
  }
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const require = createRequire(pathToFileURL(resolve(directory, "package.json")));
  const modules = new Map();
  for (const [key, entry] of Object.entries(manifest.exports)) {
    const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`;
    modules.set(key, await import(pathToFileURL(require.resolve(specifier)).href));
    assert.ok(existsSync(resolve(directory, entry.types)), `${key} declaration target`);
    console.log(`Node import PASS ${specifier}`);
  }
  const load = (path) => import(pathToFileURL(resolve(directory, path)).href);
  for (const key of Object.keys(manifest.imports)) await import(pathToFileURL(require.resolve(key)).href);
  assert.equal(modules.get(".").createRuntime, (await import(pathToFileURL(require.resolve("#turn/runtime/create-runtime")).href)).createRuntime);
  assert.equal(modules.get("./tools").createToolContext, (await load("src/tools/shared/tool-context.js")).createToolContext);
  assert.equal(modules.get("./engine/sessions.js").nativeSessionRegistry, (await load("src/engine/session-lifecycle.js")).nativeSessionRegistry);
  const HostError = modules.get("./host/config").TurnHostError;
  await assert.rejects(modules.get("./host").createMonoRuntime().run(" ", {
    model: { provider: "fictional", model: "fixture", reference: "fictional:fixture" },
  }), (error) => error instanceof HostError && error.code === "invalid_runtime_options");
  for (const path of ["contracts/model.js", "contracts/model.d.ts"]) {
    const legacy = path.endsWith(".d.ts") ? resolve(directory, "types", path) : resolve(directory, "src", path);
    const compiled = resolve(directory, "dist", path);
    if (existsSync(compiled)) assert.equal(digest(readFileSync(legacy)), digest(readFileSync(compiled)), path);
    console.log(`Materialized SHA256 ${path} ${digest(readFileSync(legacy))}`);
  }
  assert.throws(() => require.resolve(`${manifest.name}/agent/tools/index.js`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  console.log("PASS module identity, protected host failure and materialized products");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "build") await build();
    else if (command === "typecheck") await typecheck();
    else if (command === "verify-installed") await verifyInstalled(args[0] ? resolve(args[0]) : packageDirectory);
    else if (command === "source-view") {
      const argv = args[0] === "--" ? args.slice(1) : args;
      if (!argv.length) throw new Error("source-view requires a command");
      process.exitCode = await withSourceView(() => runCommand(argv[0], argv.slice(1), process.cwd()));
    } else throw new Error("Usage: staged-build.mjs <build|typecheck|verify-installed [directory]|source-view -- command>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode ||= 1;
  }
}
