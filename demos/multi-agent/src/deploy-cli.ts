#!/usr/bin/env node
import {
  checkOllamaModels,
  modelReferenceFor,
  writeMultiAgentDeploymentFiles,
} from "./deployment.js";
import type { OllamaReadiness } from "./deployment.js";
import { parseMultiAgentDeployCliArgs } from "./cli-args.js";
import { startMultiAgentDemo } from "./multi-agent-demo.js";

async function main(): Promise<void> {
  const args = parseMultiAgentDeployCliArgs(process.argv.slice(2), process.env);
  if (args.help) {
    printHelp();
    return;
  }

  const readiness = await checkOllamaModels({
    model: args.model,
    ...(args.orchestratorModel === undefined ? {} : { orchestratorModel: args.orchestratorModel }),
    ...(args.researcherModel === undefined ? {} : { researcherModel: args.researcherModel }),
    ...(args.workerModel === undefined ? {} : { workerModel: args.workerModel }),
    ollamaBaseUrl: args.ollamaBaseUrl,
  });
  const failure = readiness.find((entry) => entry.kind !== "ready");
  if (failure !== undefined) {
    printReadinessFailure(failure);
    process.exitCode = 1;
    return;
  }

  const files = await writeMultiAgentDeploymentFiles({
    cwd: process.cwd(),
    ...(args.configDir === undefined ? {} : { configDir: args.configDir }),
    model: args.model,
    ...(args.orchestratorModel === undefined ? {} : { orchestratorModel: args.orchestratorModel }),
    ...(args.researcherModel === undefined ? {} : { researcherModel: args.researcherModel }),
    ...(args.workerModel === undefined ? {} : { workerModel: args.workerModel }),
    ollamaBaseUrl: args.ollamaBaseUrl,
    ...(args.orchestratorA2APort === undefined ? {} : { orchestratorA2APort: args.orchestratorA2APort }),
    ...(args.researcherA2APort === undefined ? {} : { researcherA2APort: args.researcherA2APort }),
    ...(args.workerA2APort === undefined ? {} : { workerA2APort: args.workerA2APort }),
  });

  const roleModels = {
    orchestrator: args.orchestratorModel ?? args.model,
    researcher: args.researcherModel ?? args.model,
    worker: args.workerModel ?? args.model,
  };

  if (args.noStart) {
    console.log("multi-agent deploy config written");
    console.log(`config-dir:      ${files.configDir}`);
    console.log(`trace-registry:  ${files.traceRegistryDir}`);
    console.log(`orchestrator:    ${modelReferenceFor(roleModels.orchestrator)} (${files.roles.orchestrator.configPath})`);
    console.log(`researcher:      ${modelReferenceFor(roleModels.researcher)} (${files.roles.researcher.configPath})`);
    console.log(`worker:          ${modelReferenceFor(roleModels.worker)} (${files.roles.worker.configPath})`);
    console.log("start:           skipped (--no-start)");
    return;
  }

  const demo = await startMultiAgentDemo({
    env: process.env,
    cwd: process.cwd(),
    configDir: files.configDir,
    startTelegram: !args.noTelegram,
    startA2A: !args.noA2A,
    logger: console,
  });

  console.log(`config-dir:       ${files.configDir}`);
  console.log("edits:            edit the role config JSON, then restart the deployment to apply changes");
  console.log(`trace-registry:   ${files.traceRegistryDir}`);
  console.log(`orchestrator:     ${demo.orchestratorStatus.kind === "running" ? demo.orchestratorStatus.agentCardUrl : demo.orchestratorStatus.kind}`);
  console.log(`researcher:       ${demo.researcherStatus.kind === "running" ? demo.researcherStatus.agentCardUrl : demo.researcherStatus.kind}`);
  console.log(`worker:           ${demo.workerStatus.kind === "running" ? demo.workerStatus.agentCardUrl : demo.workerStatus.kind}`);
  console.log(`telegram:         ${demo.telegramStatus.kind}`);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal}: stopping multi-agent deployment`);
    try {
      await demo.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

function printReadinessFailure(readiness: Exclude<OllamaReadiness, { readonly kind: "ready" }>): void {
  if (readiness.kind === "model_missing") {
    console.error(`Ollama model ${readiness.model} is not installed at ${readiness.baseUrl}.`);
    if (readiness.availableModels.length > 0) {
      console.error(`Available models: ${readiness.availableModels.join(", ")}`);
    }
    console.error(`Install it with: ollama pull ${readiness.model}`);
    return;
  }
  console.error(`Ollama is not reachable at ${readiness.baseUrl}: ${readiness.reason}`);
  console.error("Start Ollama and verify it with: curl http://localhost:11434/api/tags");
}

function printHelp(): void {
  console.log(`Usage: pnpm run deploy:multi -- [options]\n\nWrites local multi-agent demo configs, checks Ollama readiness, then starts the headless role A2A providers, traceability, and optional Telegram. Config edits apply on restart.\n\nOptions:\n  --model <tag>                  Ollama model tag for all roles (default: gemma4:31b)\n  --orchestrator-model <tag>     Ollama model tag for the orchestrator\n  --researcher-model <tag>       Ollama model tag for the researcher\n  --worker-model <tag>           Ollama model tag for the worker\n  --ollama-url <url>             Ollama base URL (default: http://localhost:11434)\n  --config-dir <path>            Generated config/state directory (default: ./.mono-agent/multi-agent)\n  --orchestrator-a2a-port <port> Orchestrator A2A provider port (default: 0)\n  --researcher-a2a-port <port>   Researcher A2A provider port (default: 0)\n  --worker-a2a-port <port>       Worker A2A provider port (default: 0)\n  --no-start                     Write files and verify Ollama, but do not start\n  --no-telegram                  Do not start Telegram even if configured\n  --no-a2a                       Do not start role A2A providers\n  -h, --help                     Show this help`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
