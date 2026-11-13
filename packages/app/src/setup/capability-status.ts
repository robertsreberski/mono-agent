import { readFile } from "node:fs/promises";
import type { CapabilityCard, CapabilityChoice, CapabilityEvidence, CapabilitySetupService, CapabilitySetupSnapshot, CapabilityStatus } from "@mono-agent/channel-operator";
import { loadAppCoreConfig } from "../composition/app-config.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";
import type { ValidationReport } from "../doctor/doctor-types.js";
import { CAPABILITY_MODULES } from "./modules/catalog.js";
import { resolveModuleInputs, type CapabilityModule } from "./modules/types.js";

/** Missing evidence is never success; errors take precedence over waiting. */
export function aggregateCapabilityStatus(evidence: readonly CapabilityEvidence[]): CapabilityStatus {
  if (evidence.length === 0) return "waiting";
  if (evidence.some((item) => item.status === "error")) return "error";
  if (evidence.some((item) => item.status === "waiting")) return "waiting";
  if (evidence.every((item) => item.status === "disabled")) return "disabled";
  return "ok";
}

function moduleChoice(module: CapabilityModule, status: CapabilityStatus): CapabilityChoice {
  const discovery = module.discovery!;
  const values = resolveModuleInputs(module, {
    ...(module.id === "channel:telegram" ? { allowedChatIds: "<TELEGRAM_CHAT_ID>" } : {}),
    ...(module.id === "channel:slack" ? { allowedChannelIds: "<SLACK_CHANNEL_ID>" } : {}),
  });
  return {
    id: module.id, title: module.title, purpose: module.summary,
    requirements: discovery.requirements, usage: discovery.usage + (module.kind === "memory" && module.id !== "memory:lite" ? " Embedding/model liveness is not probed here; run mono-agent validate in the owner terminal." : ""),
    ownedConfigPaths: discovery.ownedConfigPaths, status,
    steps: [
      "In the agent folder, back up mono-agent.config.json. Merge only the shown fields; preserve unrelated settings, existing allowlists and deny rules. Replace every example placeholder before use. This console never applies changes.",
      JSON.stringify(module.configFragment(values), null, 2),
      ...(module.inputs.some((input) => input.secret)
        ? ["In the owner terminal, set the following placeholders in the owner-only .env. Never paste credentials into this console.", ...(module.envExampleLines?.(values) ?? [])] : []),
      ...(module.files?.(values).flatMap((file) => [`Create ${file.path} with the following contents:`, file.contents]) ?? []),
      ...(discovery.preparation ?? []),
      "Run mono-agent validate. Resolve waiting/error findings before starting. Restart a managed agent with mono-agent restart; for foreground use stop/start in its terminal. Validation is readiness evidence, not proof of message delivery.",
    ],
  };
}

export function capabilityCards(report: ValidationReport, memoryMode?: string): readonly CapabilityCard[] {
  const evidenceFor = (ids: readonly string[]): CapabilityEvidence[] => ids.map((id) => ({
    id, status: report.sections.find((section) => section.id === id)?.status ?? "waiting",
  }));
  const core = report.sections.find((section) => section.id === "core");
  const evidence = (ids: readonly string[]): CapabilityEvidence[] => [
    ...(core?.status === "error" ? [{ id: "core", status: "error" as const }] : []),
    ...evidenceFor(ids),
  ];
  const memoryEvidence = evidence(["memory"]);
  const variants = CAPABILITY_MODULES.filter((module) => module.kind === "memory").map((module) =>
    moduleChoice(module, module.id === `memory:${memoryMode}` ? aggregateCapabilityStatus(memoryEvidence) : "disabled"));
  const selected = variants.find((variant) => variant.id === `memory:${memoryMode}`);
  const cards: CapabilityCard[] = [{
    id: "memory", title: "Memory", purpose: "Keep useful information across conversations. Choose a tier to inspect its setup instructions, not to change the agent.",
    requirements: ["A writable memory root; Journal and BuJo also need local embeddings."],
    usage: "Lite stays local. Journal adds embeddings. BuJo also uses extraction-model tokens.",
    ownedConfigPaths: ["memory"], steps: selected?.steps ?? ["Choose Lite, Journal or BuJo to see manual setup instructions."],
    status: aggregateCapabilityStatus(memoryEvidence), evidence: memoryEvidence,
    ...(selected === undefined ? {} : { selectedVariant: selected.id }), variants,
  }];
  for (const module of CAPABILITY_MODULES.filter((module) => module.discovery !== undefined && module.kind !== "memory")) {
    const findings = evidence(module.validateExpectations.map((expectation) => expectation.sectionId));
    cards.push({ ...moduleChoice(module, aggregateCapabilityStatus(findings)), evidence: findings });
  }
  const toolsEvidence = evidence(["tools", "mcp"]);
  cards.push({
    id: "tools", title: "MCP / tools", purpose: "Let the agent use local tools and owner-prepared MCP servers.",
    requirements: ["An explicit built-in tool policy and, for external MCP, an existing validated MCP JSON file. External MCP tools bypass built-in allow/deny rules."],
    usage: "Tool use can add model turns, subprocesses and third-party service costs. External MCP server connectivity is never probed by validation. Provider/browser liveness is not probed here; run mono-agent validate in the owner terminal.",
    ownedConfigPaths: ["tools.allowedTools", "tools.disallowedTools", "tools.mcpConfigPath"],
    steps: ["Back up mono-agent.config.json; preserve existing deny rules. Merge only the tool names you intend to allow.",
      '{ "tools": { "allowedTools": ["Read", "Glob", "Grep"], "mcpConfigPath": "./mcp.json" } }',
      "Prepare and review mcp.json in the owner terminal before referencing it. Do not run untrusted server commands. Omit mcpConfigPath if you only want built-in tools.",
      "Run mono-agent validate, then mono-agent restart for a managed agent or stop/start in the foreground terminal."],
    status: aggregateCapabilityStatus(toolsEvidence), evidence: toolsEvidence,
  });
  const traceEvidence = evidence(["observability"]);
  cards.push({
    id: "tracing", title: "Built-in tracing", purpose: "Already enabled: the app records local run evidence for diagnostics and discovery.",
    requirements: ["No extra exporter or service is required."], usage: "Local disk usage; no separate model calls. External trace exporters are not supported.",
    ownedConfigPaths: [], steps: ["No enable step is needed. Use mono-agent runs to inspect local run evidence. Phoenix/OTLP exporters were removed and cannot be enabled."],
    status: aggregateCapabilityStatus(traceEvidence), evidence: traceEvidence,
  });
  return cards;
}

/** Agent-owned, coalesced read-only checks. A hung check never permits unbounded replacement work. */
export function createCapabilityStatusService(
  input: ValidateMonoAgentFolderOptions,
  dependencies: {
    readonly validate?: typeof validateMonoAgentFolder;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly hostPreflight?: () => CapabilitySetupSnapshot["hostPreflight"];
  } = {},
): CapabilitySetupService {
  const now = dependencies.now ?? Date.now;
  const startedAt = new Date(performance.timeOrigin).toISOString();
  let pending: Promise<CapabilitySetupSnapshot> | undefined;
  let cached: CapabilitySetupSnapshot | undefined;
  let cachedUntil = 0;
  let cachedFailure: Error | undefined;
  const validate = dependencies.validate ?? validateMonoAgentFolder;
  const read = async (): Promise<CapabilitySetupSnapshot> => {
    const before = await readFile(input.configPath);
    const report = await validate({ ...input, allowFilesystemWrites: false, liveness: false });
    const config = await loadAppCoreConfig(input, { warnOnDeprecatedConfig: false, warnOnDuplicateConfig: false }).catch(() => undefined);
    const after = await readFile(input.configPath);
    if (!before.equals(after)) throw new Error("Configuration changed during validation.");
    const hostPreflight = dependencies.hostPreflight?.();
    return {
      version: 1, observedAt: new Date(now()).toISOString(), process: { pid: process.pid, startedAt },
      observation: input.privateRuntimePaths === undefined ? "durable-inputs" : "loaded-snapshot", cards: capabilityCards(report, config?.memory?.mode),
      ...(hostPreflight === undefined ? {} : { hostPreflight }),
    };
  };
  return {
    async read() {
      if (now() < cachedUntil) {
        if (cachedFailure !== undefined) throw cachedFailure;
        if (cached !== undefined) return cached;
      }
      pending ??= read().then((snapshot) => {
        cachedFailure = undefined; cached = snapshot; cachedUntil = now() + 5000; return snapshot;
      }, () => {
        cached = undefined;
        cachedFailure = new Error("Capability validation unavailable. Run mono-agent validate.");
        cachedUntil = now() + 5000;
        throw cachedFailure;
      }).finally(() => { pending = undefined; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Capability validation timed out.")), dependencies.timeoutMs ?? 30_000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}
