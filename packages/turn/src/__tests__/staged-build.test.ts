import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createToolContext } from "@mono-agent/turn/tools";
import { createRuntime } from "@mono-agent/turn";
import { nativeSessionRegistry } from "@mono-agent/turn/engine/sessions.js";
import { createToolContext as internalContext } from "../tools/shared/tool-context.js";
import { nativeSessionRegistry as internalRegistry } from "../engine/session-lifecycle.js";
import { createRuntime as internalRuntime } from "../runtime/create-runtime.js";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { TurnHostError } from "@mono-agent/turn/host/config";
import { TurnHostError as internalHostError } from "../host/model-reference.js";

const { build, typecheck, withSourceView } = await import(new URL("../../scripts/staged-build.mjs", import.meta.url).href) as {
  build(directory: string, execute: (args: string[], directory: string) => void): Record<string, string>;
  build(directory: string): Promise<Record<string, string>>;
  typecheck(directory: string, execute: (args: string[], directory: string) => void): void;
  withSourceView<T>(action: () => T, directory: string): T;
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(fileURLToPath(new URL("../../node_modules/staged-build-test-", import.meta.url)));
  directories.push(directory);
  function put(name: string, text: string) {
    mkdirSync(dirname(resolve(directory, name)), { recursive: true });
    writeFileSync(resolve(directory, name), text);
  }
  put(".gitignore", "/src/model.js\n/src/leaf.d.ts\n");
  put("package.json", '{"type":"module"}');
  put("tsconfig.build.json", "{}");
  put("tsconfig.json", "{}");
  put("tsconfig.test.json", "{}");
  put("src/model.ts", 'export const model = "fixture";');
  put("src/leaf.js", 'export const leaf = "authored";');
  put("src/host/sandbox/srt-embed-runner.mjs", "// fixture runner\n");
  const commands: string[][] = [];
  function execute(args: string[]) {
    commands.push(args);
    const output = args[args.indexOf("--outDir") + 1];
    if (args.includes("--emitDeclarationOnly")) {
      put(join(output!, "model.d.ts"), 'export declare const model = "fixture";\n');
    } else if (args.at(-1) === "tsconfig.build.json") {
      put(join(output!, "model.js"), 'export const model = "fixture";\n');
      put(join(output!, "model.d.ts"), 'export declare const model = "fixture";\n');
      put(join(output!, "leaf.js"), 'export const leaf = "authored";\n');
      put(join(output!, "leaf.d.ts"), 'export declare const leaf = "authored";\n');
    }
  }
  return { directory, put, commands, execute };
}

it("emits production once, materializes identical bytes/hashes and repeats without stale input", () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hashes = build(f.directory, f.execute);
    expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(readFileSync(join(f.directory, "dist/model.js")));
    expect(readFileSync(join(f.directory, "types/model.d.ts"))).toEqual(readFileSync(join(f.directory, "dist/model.d.ts")));
    expect(hashes["src/model.js"]).toBe(createHash("sha256").update(readFileSync(join(f.directory, "dist/model.js"))).digest("hex"));
    expect(readFileSync(join(f.directory, "src/leaf.js"), "utf8")).toContain("authored");
  }
  expect(f.commands.map((args) => args.at(-1)!.split("/").at(-1))).toEqual([
    "tsconfig.build.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.json",
    "tsconfig.build.json", "tsconfig.json", "tsconfig.test.json", "tsconfig.json",
  ]);
});

it("cleans only generated paths for a scanner and restores them on throws and nonzero returns", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const original = readFileSync(join(f.directory, "src/model.js"));
  expect(() => withSourceView(() => {
    expect(existsSync(join(f.directory, "src/model.js"))).toBe(false);
    expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
    expect(existsSync(join(f.directory, "src/model.ts"))).toBe(true);
    expect(existsSync(join(f.directory, "src/leaf.js"))).toBe(true);
    throw new Error("scanner failure");
  }, f.directory)).toThrow("scanner failure");
  expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(original);
  expect(withSourceView(() => 7, f.directory)).toBe(7);
  expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(original);
});

it("supports source inspection before a build without inventing outputs", () => {
  const f = fixture();
  expect(withSourceView(() => 0, f.directory)).toBe(0);
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(false);
  expect(existsSync(join(f.directory, "dist"))).toBe(false);
});

it("refuses collisions and modified products rather than deleting them", () => {
  const f = fixture();
  f.put("src/model.js", "// authored collision");
  expect(() => build(f.directory, f.execute)).toThrow(/unowned or modified/);
  expect(readFileSync(join(f.directory, "src/model.js"), "utf8")).toBe("// authored collision");
  rmSync(join(f.directory, "src/model.js"));
  build(f.directory, f.execute);
  f.put("src/model.js", "// modified compiler product");
  expect(() => withSourceView(() => 0, f.directory)).toThrow(/unowned or modified/);
  expect(() => build(f.directory, f.execute)).toThrow(/unowned or modified.*delete src\/model.js, then run pnpm/);
  rmSync(join(f.directory, "src/model.js"));
  build(f.directory, f.execute);
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(true);
});

it("refuses stale source/output before removing any product", () => {
  const f = fixture();
  build(f.directory, f.execute);
  f.put("dist/model.js", "// changed output");
  expect(() => withSourceView(() => 0, f.directory)).toThrow(/Stale compiler product/);
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(true);
  build(f.directory, f.execute);
  f.put("src/model.ts", "// changed source");
  expect(withSourceView(() => 0, f.directory)).toBe(0);
  expect(() => typecheck(f.directory, f.execute)).toThrow(/outputs are stale; run pnpm/);
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(true);
});

it("cleans incomplete outputs when strict checking fails, keeping authored sources", () => {
  const f = fixture();
  expect(() => build(f.directory, (args) => {
    f.execute(args);
    if (args.at(-1)!.endsWith("tsconfig.test.json")) throw new Error("strict check failure");
  })).toThrow("strict check failure");
  for (const path of ["dist", "types", "src/model.js", "src/leaf.d.ts"]) {
    expect(existsSync(join(f.directory, path)), path).toBe(false);
  }
  expect(existsSync(join(f.directory, "src/model.ts"))).toBe(true);
  expect(existsSync(join(f.directory, "src/leaf.js"))).toBe(true);
});

it.each(["build", "typecheck", "source-view"])("recovers owned overlays and a dead lock after an interrupted run before %s", (entry) => {
  const f = fixture();
  build(f.directory, f.execute);
  // A child exits without cleanup, leaving exactly the pre-published ownership
  // record and compiler product a killed compiler would leave behind.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createHash } from "node:crypto";
    import { readFileSync, writeFileSync, symlinkSync } from "node:fs";
    import { join } from "node:path";
    const directory = process.argv[1];
    const statePath = join(directory, "node_modules/.cache/staged-build.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const bytes = readFileSync(join(directory, "dist/leaf.d.ts"));
    state.overlays = { "src/leaf.d.ts": createHash("sha256").update(bytes).digest("hex") };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(join(directory, "src/leaf.d.ts"), bytes);
    symlinkSync(String(process.pid), join(directory, "node_modules/.cache/staged-build.lock"));
  `, f.directory]);
  if (entry === "build") build(f.directory, (args) => {
    if (args.at(-1) === "tsconfig.build.json") expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
    f.execute(args);
  });
  else if (entry === "typecheck") typecheck(f.directory, (args) => {
    expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(true);
    f.execute(args);
  });
  else withSourceView(() => expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false), f.directory);
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
});

it("never exposes declaration overlays after strict success or failure", () => {
  const f = fixture();
  build(f.directory, f.execute);
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
  expect(() => typecheck(f.directory, () => {
    expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(true);
    throw new Error("strict check failure");
  })).toThrow("strict check failure");
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
  typecheck(f.directory, f.execute);
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
});

it("keeps public and internal source state and protected host failures on one identity", async () => {
  expect(createToolContext).toBe(internalContext);
  expect(createRuntime).toBe(internalRuntime);
  expect(nativeSessionRegistry).toBe(internalRegistry);
  expect(TurnHostError).toBe(internalHostError);
  const runtime = createRuntime({ workspace: "/fictional" });
  expect(typeof runtime.run).toBe("function");
  await expect(createMonoRuntime().run(" ", {
    model: { provider: "fictional", model: "fixture", reference: "fictional:fixture" },
    messages: [],
    abortSignal: new AbortController().signal,
  })).rejects.toBeInstanceOf(internalHostError);
});

it("preserves an authored overlay and cleans other owned overlays without masking the original failure", () => {
  const f = fixture();
  f.put("src/leaf.d.ts", "// authored declaration");
  expect(() => build(f.directory, f.execute)).toThrow(/unowned or modified overlay/);
  expect(readFileSync(join(f.directory, "src/leaf.d.ts"), "utf8")).toBe("// authored declaration");
  rmSync(join(f.directory, "src/leaf.d.ts"));
  f.put(".gitignore", "/src/model.js\n/src/leaf.d.ts\n/src/other.d.ts\n");
  const execute = (args: string[]) => {
    f.execute(args);
    if (args.at(-1) === "tsconfig.build.json") f.put(join(args[args.indexOf("--outDir") + 1]!, "other.d.ts"), "export {};\n");
  };
  build(f.directory, execute);
  expect(() => typecheck(f.directory, () => {
    f.put("src/leaf.d.ts", "// changed declaration");
    throw new Error("original compiler failure");
  })).toThrow(/^original compiler failure; cleanup: Refusing to remove unowned or modified overlay/);
  expect(existsSync(join(f.directory, "src/other.d.ts"))).toBe(false);
  expect(readFileSync(join(f.directory, "src/leaf.d.ts"), "utf8")).toBe("// changed declaration");
});

it("refuses a converted implementation absent from the ownership inventory, preserving good outputs", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const good = readFileSync(join(f.directory, "dist/model.js"));
  f.put("src/extra.ts", "export const extra = 1;");
  expect(() => build(f.directory, (args) => {
    f.execute(args);
    if (args.at(-1) === "tsconfig.build.json") f.put(join(args[args.indexOf("--outDir") + 1]!, "extra.js"), "export const extra = 1;\n");
  })).toThrow("Unregistered compiler product: src/extra.js");
  expect(readFileSync(join(f.directory, "dist/model.js"))).toEqual(good);
  expect(existsSync(join(f.directory, "src/extra.js"))).toBe(false);
});

it("keeps previous good dist, declarations, products and state when strict checks fail", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const paths = ["dist/model.js", "types/model.d.ts", "src/model.js", "node_modules/.cache/staged-build.json"];
  const good = paths.map((path) => readFileSync(join(f.directory, path)));
  f.put("src/model.ts", "// failed edit");
  expect(() => build(f.directory, (args) => {
    f.execute(args);
    if (args.at(-1)!.endsWith("tsconfig.test.json")) throw new Error("strict failure");
  })).toThrow("strict failure");
  expect(paths.map((path) => readFileSync(join(f.directory, path)))).toEqual(good);
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
});

it("recovers inventory products after the node_modules ownership cache is purged", () => {
  const f = fixture();
  build(f.directory, f.execute);
  f.put("src/leaf.d.ts", readFileSync(join(f.directory, "dist/leaf.d.ts"), "utf8"));
  rmSync(join(f.directory, "node_modules"), { recursive: true });
  expect(withSourceView(() => 3, f.directory)).toBe(3);
  expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(true);
  build(f.directory, f.execute);
  rmSync(join(f.directory, "node_modules"), { recursive: true });
  f.put("src/model.js", "// not the compiler product");
  expect(() => build(f.directory, f.execute)).toThrow(/unowned or modified.*run pnpm/);
});

it("restores a missing owned product from the verified compiler copy", () => {
  const f = fixture();
  build(f.directory, f.execute);
  rmSync(join(f.directory, "src/model.js"));
  typecheck(f.directory, f.execute);
  expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(readFileSync(join(f.directory, "dist/model.js")));
});

it("recovers a reused PID lock but refuses the actual live owner", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const path = join(f.directory, "node_modules/.cache/staged-build.lock");
  symlinkSync(JSON.stringify({ pid: process.pid, start: "fictional earlier boot" }), path);
  build(f.directory, f.execute);
  const start = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
  symlinkSync(JSON.stringify({ pid: process.pid, start }), path);
  expect(() => build(f.directory, f.execute)).toThrow("already active");
});

it("requires private strict and production paths to follow authored implementations", () => {
  const directory = fileURLToPath(new URL("../../", import.meta.url));
  const owned = readFileSync(join(directory, ".gitignore"), "utf8").split("\n");
  for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
    const config = JSON.parse(readFileSync(join(directory, name), "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
    for (const [key, targets] of Object.entries(config.compilerOptions.paths)) {
      for (const target of targets) {
        const authored = target.endsWith(".ts") && !target.endsWith(".d.ts") && existsSync(resolve(directory, target));
        const overlay = name === "tsconfig.json" && owned.includes(target.replace(/^\.\//u, "/"))
          && !existsSync(resolve(directory, target.replace(/\.d\.ts$/u, ".ts")));
        const legacy = name === "tsconfig.build.json" && target.endsWith(".js") && existsSync(resolve(directory, target))
          && !owned.includes(target.replace(/^\.\//u, "/")) && !existsSync(resolve(directory, target.replace(/\.js$/u, ".ts")));
        expect(authored || overlay || legacy, `${name} ${key}: ${target} must never fall back to old types or generated JS`).toBe(true);
      }
    }
  }
});

it("rejects non-strict inferred TS declarations and accepts explicit strict-correct annotations", async () => {
  const f = fixture();
  const common = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true, rootDir: "src" };
  f.put("tsconfig.build.json", JSON.stringify({ compilerOptions: { ...common, allowJs: true, checkJs: true, declaration: true }, include: ["src/model.ts", "src/leaf.js"] }));
  f.put("tsconfig.json", JSON.stringify({ compilerOptions: { ...common, strict: true, noEmit: true }, include: ["src/model.ts"] }));
  f.put("tsconfig.test.json", JSON.stringify({ extends: "./tsconfig.json" }));
  await build(f.directory);
  const good = readFileSync(join(f.directory, "dist/model.js"));
  f.put("src/model.ts", 'export const model = ["one"].find(value => value.length > 0);');
  await expect(build(f.directory)).rejects.toThrow("Strict declaration mismatch: model.d.ts");
  expect(readFileSync(join(f.directory, "dist/model.js"))).toEqual(good);
  f.put("src/model.ts", 'export const model: string | undefined = ["one"].find(value => value.length > 0);');
  await build(f.directory);
  expect(readFileSync(join(f.directory, "types/model.d.ts"), "utf8")).toContain("string | undefined");
}, 30000);

async function waitReady(path: string, child: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture child exited before ready");
    await new Promise((accept) => setTimeout(accept, 10));
  }
  child.kill("SIGKILL");
  throw new Error("fixture child did not reach its controlled interruption point");
}

it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("unwinds build, typecheck and source-view on %s", async (signal) => {
  for (const operation of ["build", "typecheck", "source-view"]) {
    const f = fixture();
    build(f.directory, f.execute);
    const helper = new URL("../../scripts/staged-build.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import path from 'node:path';
      import { build, typecheck, withSourceView, runCommand } from ${JSON.stringify(helper)};
      const directory=process.argv[1], operation=process.argv[2];
      const pause=()=>{fs.writeFileSync(path.join(directory,'ready'),'');return runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],directory);};
      const execute=(args)=>{if(args.at(-1)==='tsconfig.build.json'){
        fs.cpSync(path.join(directory,'dist'),args[args.indexOf('--outDir')+1],{recursive:true});return;
      }return pause();};
      try {if(operation==='build')await build(directory,execute);else if(operation==='typecheck')await typecheck(directory,execute);else await withSourceView(pause,directory);}
      catch(error){process.exitCode ||= 1;}
    `, f.directory, operation], { stdio: "ignore" });
    const exit = once(child, "exit");
    try {
      await waitReady(join(f.directory, "ready"), child);
      child.kill(signal);
      const [code] = await exit;
      expect(code).toBe({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
      expect(existsSync(join(f.directory, "src/leaf.d.ts"))).toBe(false);
      expect(existsSync(join(f.directory, "node_modules/.cache/staged-build.lock"))).toBe(false);
      expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(readFileSync(join(f.directory, "dist/model.js")));
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } }
  }
});

it("restores a durably hidden source product after uncatchable source-view termination", async () => {
  const f = fixture();
  build(f.directory, f.execute);
  const helper = new URL("../../scripts/staged-build.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import path from 'node:path';
    import { withSourceView, runCommand } from ${JSON.stringify(helper)};
    const directory=process.argv[1]; await withSourceView(()=>{
      fs.writeFileSync(path.join(directory,'ready'),'');
      return new Promise(()=>{setInterval(()=>{},1000);});
    },directory);
  `, f.directory], { stdio: "ignore" });
  const exit = once(child, "exit");
  try {
    await waitReady(join(f.directory, "ready"), child);
    expect(existsSync(join(f.directory, "src/model.js"))).toBe(false);
    const state = JSON.parse(readFileSync(join(f.directory, "node_modules/.cache/staged-build.json"), "utf8")) as { hidden: string[] };
    expect(state.hidden).toContain("src/model.js");
    child.kill("SIGKILL");
    await exit;
    typecheck(f.directory, f.execute);
    expect(readFileSync(join(f.directory, "src/model.js"))).toEqual(readFileSync(join(f.directory, "dist/model.js")));
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } }
});

it("journals ownership before publication and rolls back a killed publication on next entry", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const good = ["dist/model.js", "types/model.d.ts", "src/model.js"].map((path) => readFileSync(join(f.directory, path)));
  const helper = new URL("../../scripts/staged-build.mjs", import.meta.url).href;
  const result = spawnSyncPublication(f.directory, helper);
  expect(result).toBe(77);
  typecheck(f.directory, f.execute);
  expect(["dist/model.js", "types/model.d.ts", "src/model.js"].map((path) => readFileSync(join(f.directory, path)))).toEqual(good);
});

function spawnSyncPublication(directory: string, helper: string) {
  // The child exits at the first product write, after dist/types publication.
  // This is deliberately uncatchable, so recovery must use the on-disk journal.
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
      const directory=process.argv[1], write=fs.writeFileSync;
      fs.writeFileSync=(target,...args)=>{
        if(target===path.join(directory,'src/model.js')){
          const state=JSON.parse(fs.readFileSync(path.join(directory,'node_modules/.cache/staged-build.json'),'utf8'));
          if(!state.transaction||!state.products['src/model.js'])process.exit(78);
          process.exit(77);
        }return write(target,...args);
      };syncBuiltinESMExports();
      const { build }=await import(${JSON.stringify(helper)});
      build(directory,args=>{
        if(args.at(-1)==='tsconfig.build.json'){
          const out=args[args.indexOf('--outDir')+1];fs.cpSync(path.join(directory,'dist'),out,{recursive:true});
          write(path.join(out,'model.js'),'export const model="replacement";');
        }else if(args.includes('--emitDeclarationOnly')){
          const out=args[args.indexOf('--outDir')+1];fs.mkdirSync(out,{recursive:true});
          write(path.join(out,'model.d.ts'),fs.readFileSync(path.join(directory,'dist/model.d.ts')));
        }
      });
    `, directory], { stdio: "ignore" });
    return 0;
  } catch (error) { return (error as { status: number }).status; }
}

it("does not label an output fresh when source changes during compiler execution", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const good = readFileSync(join(f.directory, "dist/model.js"));
  expect(() => build(f.directory, (args) => {
    f.execute(args);
    if (args.at(-1)!.endsWith("tsconfig.test.json")) f.put("src/model.ts", "// concurrent edit");
  })).toThrow("Sources changed during staged build");
  expect(readFileSync(join(f.directory, "dist/model.js"))).toEqual(good);
});

it("deletes superseded previous products after a successful publication", () => {
  const f = fixture();
  build(f.directory, f.execute);
  rmSync(join(f.directory, "src/model.ts"));
  const products = build(f.directory, (args) => {
    if (args.at(-1) === "tsconfig.build.json") {
      const out = args[args.indexOf("--outDir") + 1]!;
      f.put(join(out, "leaf.js"), 'export const leaf = "authored";\n');
      f.put(join(out, "leaf.d.ts"), 'export declare const leaf = "authored";\n');
    }
  });
  expect(products).toEqual({});
  expect(existsSync(join(f.directory, "src/model.js"))).toBe(false);
  expect(existsSync(join(f.directory, "types/model.d.ts"))).toBe(false);
});

it("works without ps, recovering proven stale identities but refusing unproven live owners", () => {
  const f = fixture();
  build(f.directory, f.execute);
  const helper = new URL("../../scripts/staged-build.mjs", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    import { withSourceView } from ${JSON.stringify(helper)};
    const directory=process.argv[1], lock=path.join(directory,'node_modules/.cache/staged-build.lock');
    let start;withSourceView(()=>{start=JSON.parse(fs.readlinkSync(lock)).start;},directory);
    assert.match(start,/^(?:proc:|self:)/);
    fs.symlinkSync(JSON.stringify({pid:process.pid,start:start+'-previous'}),lock);
    withSourceView(()=>{},directory);
    fs.symlinkSync(JSON.stringify({pid:process.ppid,start:'self:unverifiable'}),lock);
    assert.throws(()=>withSourceView(()=>{},directory),/already active/);
    fs.rmSync(lock);
    console.log('fallback and conservative live-owner refusal passed');
  `, f.directory], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  expect(result).toContain("fallback and conservative live-owner refusal passed");
});
