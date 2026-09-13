import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAgentHarness,
  createDurableHistoryStore,
} from "../packages/agent-harness/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "mono-context-import-smoke-"));
let runtimeCalls = 0;
let crashChild;
try {
  const identityPath = join(root, "IDENTITY.md");
  await writeFile(identityPath, "You are the context import smoke fixture.\n", "utf8");
  const historyStore = createDurableHistoryStore({ root: join(root, "history") });

  const harnessModule = pathToFileURL(join(process.cwd(), "packages/agent-harness/dist/index.js")).href;
  const childCode = [
    `import { createDurableHistoryStore } from ${JSON.stringify(harnessModule)};`,
    "const store = createDurableHistoryStore({ root: process.argv[1] });",
    'await store.contextImport.beginExclusiveTurn("smoke:crash");',
    'process.stdout.write("HELD\\n");',
    "setInterval(() => undefined, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode, join(root, "history")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  crashChild = child;
  const childErrors = [];
  child.stderr.on("data", (chunk) => childErrors.push(Buffer.from(chunk)));
  const [held] = await once(child.stdout, "data");
  if (!Buffer.from(held).toString("utf8").includes("HELD")) throw new Error("Crash fixture did not acquire its lease.");
  let overlapSettled = false;
  const overlap = historyStore.contextImport.prepareImport("smoke:crash", {
    text: "crash-recovered snapshot",
    idempotencyKey: "smoke:crash:run-1",
    timestamp: "2026-09-08T10:00:00.000Z",
  }).then((value) => { overlapSettled = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (overlapSettled) throw new Error("Same-conversation import bypassed the independent-process lease.");
  child.kill("SIGKILL");
  await once(child, "exit");
  crashChild = undefined;
  if (childErrors.length > 0) throw new Error(`Crash fixture stderr: ${Buffer.concat(childErrors).toString("utf8")}`);
  const recovered = await overlap;
  if (recovered.result.status !== "appended" || recovered.append === undefined) {
    throw new Error(`Crash recovery did not prepare the import: ${JSON.stringify(recovered.result)}`);
  }
  await recovered.append.commit();

  const harness = createAgentHarness({
    identityPath,
    cwd: root,
    model: { provider: "fixture", model: "fixture", reference: "fixture:fixture" },
    runtime: {
      async run() {
        runtimeCalls += 1;
        return { text: "unexpected runtime call" };
      },
    },
    historyStore,
    now: () => new Date("2026-09-08T10:00:00.000Z"),
  });
  const request = { text: "controlled built-artifact snapshot", idempotencyKey: "smoke:source:run-1" };
  const first = await harness.importContext?.("smoke:conversation", request);
  const retry = await harness.importContext?.("smoke:conversation", request);
  const history = await historyStore.load("smoke:conversation");
  if (first?.status !== "appended" || retry?.status !== "duplicate") {
    throw new Error(`Unexpected import outcomes: ${JSON.stringify({ first, retry })}`);
  }
  if (history.length !== 2 || history[1]?.content !== request.text || runtimeCalls !== 0) {
    throw new Error(`Smoke invariant failed: ${JSON.stringify({ historyLength: history.length, runtimeCalls })}`);
  }
  process.stdout.write("context-import smoke passed: cross-process crash recovery, appended, duplicate retry, two-message batch, zero runtime calls\n");
} finally {
  if (crashChild?.exitCode === null && crashChild.signalCode === null) crashChild.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
