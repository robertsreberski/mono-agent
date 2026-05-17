import { resolve } from "node:path";

export interface MultiAgentCliArgs {
  readonly configDir?: string;
  readonly port?: number;
  readonly noTelegram: boolean;
  readonly noA2A: boolean;
  readonly help: boolean;
}

export interface MultiAgentDeployCliArgs {
  readonly configDir?: string;
  readonly model: string;
  readonly orchestratorModel?: string;
  readonly researcherModel?: string;
  readonly workerModel?: string;
  readonly ollamaBaseUrl: string;
  readonly port?: number;
  readonly orchestratorA2APort?: number;
  readonly researcherA2APort?: number;
  readonly workerA2APort?: number;
  readonly noStart: boolean;
  readonly noTelegram: boolean;
  readonly noA2A: boolean;
  readonly help: boolean;
}

export function parseMultiAgentCliArgs(argv: readonly string[], cwd = process.cwd()): MultiAgentCliArgs {
  let configDir: string | undefined;
  let port: number | undefined;
  let noTelegram = false;
  let noA2A = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-telegram") {
      noTelegram = true;
      continue;
    }
    if (arg === "--no-a2a") {
      noA2A = true;
      continue;
    }
    if (arg === "--config-dir") {
      configDir = resolve(cwd, readStringArg(argv, i, "--config-dir"));
      i += 1;
      continue;
    }
    if (arg === "--port") {
      port = readPortArg(argv, i, "--port");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    noTelegram,
    noA2A,
    help,
    ...(configDir === undefined ? {} : { configDir }),
    ...(port === undefined ? {} : { port }),
  };
}

export function parseMultiAgentDeployCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): MultiAgentDeployCliArgs {
  let configDir: string | undefined;
  let model = env.MONO_AGENT_MULTI_AGENT_MODEL?.trim() || "gemma4:31b";
  let orchestratorModel: string | undefined = env.MONO_AGENT_MULTI_AGENT_ORCHESTRATOR_MODEL?.trim() || undefined;
  let researcherModel: string | undefined = env.MONO_AGENT_MULTI_AGENT_RESEARCHER_MODEL?.trim() || undefined;
  let workerModel: string | undefined = env.MONO_AGENT_MULTI_AGENT_WORKER_MODEL?.trim() || undefined;
  let ollamaBaseUrl = env.MONO_AGENT_MULTI_AGENT_OLLAMA_URL?.trim() || "http://localhost:11434";
  let port: number | undefined;
  let orchestratorA2APort: number | undefined;
  let researcherA2APort: number | undefined;
  let workerA2APort: number | undefined;
  let noStart = false;
  let noTelegram = false;
  let noA2A = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-start") {
      noStart = true;
      continue;
    }
    if (arg === "--no-telegram") {
      noTelegram = true;
      continue;
    }
    if (arg === "--no-a2a") {
      noA2A = true;
      continue;
    }
    if (arg === "--config-dir") {
      configDir = resolve(cwd, readStringArg(argv, i, "--config-dir"));
      i += 1;
      continue;
    }
    if (arg === "--model") {
      model = readStringArg(argv, i, "--model");
      i += 1;
      continue;
    }
    if (arg === "--orchestrator-model") {
      orchestratorModel = readStringArg(argv, i, "--orchestrator-model");
      i += 1;
      continue;
    }
    if (arg === "--researcher-model") {
      researcherModel = readStringArg(argv, i, "--researcher-model");
      i += 1;
      continue;
    }
    if (arg === "--worker-model") {
      workerModel = readStringArg(argv, i, "--worker-model");
      i += 1;
      continue;
    }
    if (arg === "--ollama-url") {
      ollamaBaseUrl = readStringArg(argv, i, "--ollama-url");
      i += 1;
      continue;
    }
    if (arg === "--port") {
      port = readPortArg(argv, i, "--port");
      i += 1;
      continue;
    }
    if (arg === "--orchestrator-a2a-port") {
      orchestratorA2APort = readPortArg(argv, i, "--orchestrator-a2a-port");
      i += 1;
      continue;
    }
    if (arg === "--researcher-a2a-port") {
      researcherA2APort = readPortArg(argv, i, "--researcher-a2a-port");
      i += 1;
      continue;
    }
    if (arg === "--worker-a2a-port") {
      workerA2APort = readPortArg(argv, i, "--worker-a2a-port");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    model,
    ollamaBaseUrl,
    noStart,
    noTelegram,
    noA2A,
    help,
    ...(configDir === undefined ? {} : { configDir }),
    ...(orchestratorModel === undefined ? {} : { orchestratorModel }),
    ...(researcherModel === undefined ? {} : { researcherModel }),
    ...(workerModel === undefined ? {} : { workerModel }),
    ...(port === undefined ? {} : { port }),
    ...(orchestratorA2APort === undefined ? {} : { orchestratorA2APort }),
    ...(researcherA2APort === undefined ? {} : { researcherA2APort }),
    ...(workerA2APort === undefined ? {} : { workerA2APort }),
  };
}

function readStringArg(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} requires a value.`);
  }
  return value.trim();
}

function readPortArg(argv: readonly string[], index: number, name: string): number {
  const value = readStringArg(argv, index, name);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} requires a numeric port.`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be between 0 and 65535.`);
  }
  return port;
}
