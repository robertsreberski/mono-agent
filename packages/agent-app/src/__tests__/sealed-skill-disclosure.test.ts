import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import {
  createMonoRuntime,
  type MonoRuntimeLike,
  type RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import { createConfiguredAgentHarness } from "../index.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";
import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";

const tempDirs: string[] = [];
const model = {
  sdk: "pi",
  provider: "faux",
  model: "faux-model",
  reference: "pi:faux:faux-model",
} as const;

interface ProviderContext {
  readonly systemPrompt?: string;
  readonly tools?: readonly { readonly name: string }[];
}

interface RuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("configured sealed tool policy with progressive skill disclosure", () => {
  it("suppresses automatic memory before a sealed advisor query and preserves ordinary recall", async () => {
    const fixture = await createFixture("memory");
    const provider = createProviderObserver(2);
    const observed = observeRuntime(createMonoRuntime());
    const privateSentinel = "private host memory sentinel";
    const storeLoad = vi.fn(async () => undefined);
    const storeRecall = vi.fn(async () => [{
      score: 1,
      record: {
        id: "private-host-note",
        text: `Morgan selected ${privateSentinel} as the deployment color.`,
      },
    }]);
    const store: SharedRecallStore = {
      load: storeLoad,
      recall: storeRecall,
      async appendHostSummary(conversationId) {
        return { conversationId, source: "test", bytesWritten: 0 };
      },
      async close() {},
    };
    const memory = new MemoryRetrievalService(store);
    const memoryLoad = vi.spyOn(memory, "load");
    const advisorOverride = createRequestModelOverrideRuntimeExtension();
    const runIds = ["run-sealed-memory", "run-ordinary-memory"];
    const harness = await createConfiguredAgentHarness({
      config: {
        ...fixture.config,
        memory: {
          mode: "lite",
          path: join(fixture.dir, "memory"),
          writeMode: "disabled",
          maxBytes: 8_000,
          recallTool: { enabled: true },
        },
      },
      memory,
      runtime: observed.runtime,
      createRunId: () => runIds.shift() ?? "unexpected-run",
      runtimeOptions: {
        piResolvedModel: provider.piModel,
        piResolvedModels: provider.models,
        effort: "none",
      },
      runtimeOptionsForRequest: async (input) => await advisorOverride({ request: input.request }),
    });

    try {
      const sealedEvents: unknown[] = [];
      const sealed = await harness.run({
        conversationId: "advisor:0123456789abcdef0123456789abcdef",
        userMessage: "What deployment color did Morgan select?",
        metadata: { advisor: { model: model.reference, effort: "none" } },
        abortSignal: new AbortController().signal,
        onEvent: (event) => sealedEvents.push(event),
      });

      expect(sealed.text).toBe("provider answer");
      expect(memoryLoad).not.toHaveBeenCalled();
      expect(storeLoad).not.toHaveBeenCalled();
      expect(storeRecall).not.toHaveBeenCalled();
      const sealedRuntime = observed.calls[0];
      expect(sealedRuntime?.options.allowedTools).toEqual([]);
      expect(sealedRuntime?.options.mcpServers).toEqual({});
      expect(JSON.stringify({
        prompt: sealedRuntime?.prompt,
        messages: sealedRuntime?.options.messages,
        contextMetadata: sealed.metadata,
        events: sealedEvents,
      })).not.toContain(privateSentinel);

      const ordinary = await harness.run({
        conversationId: "ordinary:memory-control",
        userMessage: "What deployment color did Morgan select?",
        abortSignal: new AbortController().signal,
      });

      expect(ordinary.text).toBe("provider answer");
      expect(memoryLoad).toHaveBeenCalledTimes(1);
      expect(storeRecall).toHaveBeenCalledTimes(1);
      expect(storeRecall).toHaveBeenCalledWith(
        "what deployment color did morgan select?",
        { topK: 50, trackAccess: false },
      );
      expect(JSON.stringify(observed.calls[1]?.options.messages)).toContain(privateSentinel);
      expect(observed.calls[1]?.prompt).not.toContain(privateSentinel);
    } finally {
      await harness.dispose?.();
    }
  });

  it("exposes exactly the sealed empty policy through the real harness and Pi provider path", async () => {
    const fixture = await createFixture("sealed");
    const provider = createProviderObserver();
    const observed = observeRuntime(createMonoRuntime());
    const harness = await createConfiguredAgentHarness({
      config: fixture.config,
      runtime: observed.runtime,
      createRunId: () => "run-sealed-skills",
      runtimeOptions: {
        piResolvedModel: provider.piModel,
        piResolvedModels: provider.models,
        effort: "none",
        mcpConfigPath: join(fixture.dir, "configured-mcp.json"),
        mcpServers: {
          configured: { type: "http", url: "http://127.0.0.1:7310" },
        },
        skills: [{ name: "static-skill", description: "must not survive" }],
        skillsRoot: join(fixture.dir, "static-skills"),
      },
      runtimeOptionsForRequest: async () => ({
        runtimeOptions: {
          mcpServers: {
            caller: { type: "http", url: "http://127.0.0.1:7311" },
          },
          skills: [{ name: "request-skill", description: "must not survive" }],
          skillsRoot: join(fixture.dir, "request-skills"),
        },
        sealedToolPolicy: true,
        toolPolicyOverride: {
          allowedTools: [],
          disallowedTools: [],
          mcpServers: {},
        },
      }),
    });

    try {
      const response = await harness.run(request("sealed-turn"));
      const runtimeCall = observed.calls[0];
      const providerContext = provider.contexts[0];

      expect(response.text).toBe("provider answer");
      expect(runtimeCall?.options.allowedTools).toEqual([]);
      expect(runtimeCall?.options.disallowedTools).toEqual([]);
      expect(runtimeCall?.options.mcpServers).toEqual({});
      expect(runtimeCall?.options.mcpConfigPath).toBeUndefined();
      expect(runtimeCall?.options.skills).toBeUndefined();
      expect(runtimeCall?.options.skillsRoot).toBeUndefined();
      expect(providerContext?.tools?.map((tool) => tool.name) ?? []).toEqual([]);
      assertNoSkillDisclosure(runtimeCall?.prompt, fixture);
      assertNoSkillDisclosure(providerContext?.systemPrompt, fixture);
      expect(response.metadata.contextSectionIds).not.toContain("skills");
      expect(response.metadata.contextSectionIds).not.toContain("skill-instructions");
      expect(response.metadata.contextSources).toEqual([fixture.identityPath]);

      const summary = JSON.parse(
        await readFile(join(fixture.artifactDir, "run-sealed-skills.summary.json"), "utf8"),
      ) as { readonly systemPrompt?: string };
      assertNoSkillDisclosure(summary.systemPrompt, fixture);
    } finally {
      await harness.dispose?.();
    }
  });

  it("preserves ordinary index disclosure and its ReadSkill provider surface", async () => {
    const fixture = await createFixture("ordinary");
    const provider = createProviderObserver();
    const observed = observeRuntime(createMonoRuntime());
    const harness = await createConfiguredAgentHarness({
      config: fixture.config,
      runtime: observed.runtime,
      createRunId: () => "run-ordinary-skills",
      runtimeOptions: {
        piResolvedModel: provider.piModel,
        piResolvedModels: provider.models,
        effort: "none",
      },
    });

    try {
      const response = await harness.run(request("ordinary-turn"));
      const runtimeCall = observed.calls[0];
      const providerContext = provider.contexts[0];

      expect(response.text).toBe("provider answer");
      expect(runtimeCall?.options.allowedTools).toEqual(["Read"]);
      expect(runtimeCall?.options.disallowedTools).toEqual(["Write"]);
      expect(runtimeCall?.options.mcpServers).toBeUndefined();
      expect(runtimeCall?.options.skills).toEqual([
        { name: fixture.skillName, description: fixture.skillBody },
      ]);
      expect(runtimeCall?.options.skillsRoot).toBe(fixture.skillsRoot);
      expect(providerContext?.tools?.map((tool) => tool.name).sort()).toEqual(["Read", "ReadSkill"]);
      expect(runtimeCall?.prompt).toContain("call `ReadSkill` with its exact name");
      expect(runtimeCall?.prompt).toContain(fixture.skillName);
      expect(runtimeCall?.prompt).toContain(fixture.skillBody);
      expect(providerContext?.systemPrompt).toBe(runtimeCall?.prompt);
      expect(response.metadata.contextSectionIds).toContain("skills");
      expect(response.metadata.contextSectionIds).toContain("skill-instructions");
      expect(response.metadata.contextSources).toEqual([fixture.identityPath, fixture.skillPath]);
    } finally {
      await harness.dispose?.();
    }
  });
});

async function createFixture(label: string): Promise<{
  readonly dir: string;
  readonly identityPath: string;
  readonly artifactDir: string;
  readonly skillsRoot: string;
  readonly skillName: string;
  readonly skillBody: string;
  readonly skillPath: string;
  readonly config: MonoAgentConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), `agent-app-sealed-skills-${label}-`));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  const artifactDir = join(dir, "artifacts");
  const skillsRoot = join(dir, "skills");
  const skillName = "host-review-notes";
  const skillBody = "HOST_SKILL_BODY_SENTINEL";
  const skillPath = join(skillsRoot, skillName, "SKILL.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  await mkdir(join(skillsRoot, skillName), { recursive: true });
  await writeFile(skillPath, `# Host Review Notes\n\n${skillBody}\n`, "utf8");

  const config: MonoAgentConfig = {
    runtime: {
      model,
      executionMode: "sdk",
      maxTurns: 2,
      workspace: dir,
      session: { mode: "per-message", idleTimeoutMs: 60_000 },
    },
    context: {
      identityPath,
      skillsRoot,
      skillDisclosure: "index",
      selectedSkills: [skillName],
    },
    tools: {
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    },
    artifacts: {
      dir: artifactDir,
      retention: { maxAgeDays: 365, maxCount: 50_000, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 5_000, dryRun: false },
    },
    traceability: { registryDir: join(dir, "trace-sources") },
  };
  return { dir, identityPath, artifactDir, skillsRoot, skillName, skillBody, skillPath, config };
}

function createProviderObserver(responseCount = 1): {
  readonly contexts: ProviderContext[];
  readonly piModel: ReturnType<ReturnType<typeof fauxProvider>["getModel"]>;
  readonly models: ReturnType<typeof createModels>;
} {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning: false }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts: ProviderContext[] = [];
  const streamSimple = faux.provider.streamSimple.bind(faux.provider);
  faux.provider.streamSimple = (requestModel, context, options) => {
    contexts.push(context as ProviderContext);
    return streamSimple(requestModel, context, options);
  };
  faux.setResponses(Array.from(
    { length: responseCount },
    () => fauxAssistantMessage([fauxText("provider answer")]),
  ));
  return { contexts, piModel: faux.getModel(), models };
}

function observeRuntime(base: MonoRuntimeLike): {
  readonly runtime: MonoRuntimeLike;
  readonly calls: RuntimeCall[];
} {
  const calls: RuntimeCall[] = [];
  return {
    calls,
    runtime: {
      ...base,
      async run(prompt, options) {
        calls.push({ prompt, options });
        return await base.run(prompt, options);
      },
    },
  };
}

function request(conversationId: string) {
  return {
    conversationId,
    userMessage: "Review this untrusted text without using host capabilities.",
    abortSignal: new AbortController().signal,
  };
}

function assertNoSkillDisclosure(prompt: string | undefined, fixture: {
  readonly skillsRoot: string;
  readonly skillName: string;
  readonly skillBody: string;
}): void {
  expect(prompt).toBeTypeOf("string");
  expect(prompt).not.toContain("ReadSkill");
  expect(prompt).not.toContain("Skill Index");
  expect(prompt).not.toContain("Selected Skill Instructions");
  expect(prompt).not.toContain(fixture.skillName);
  expect(prompt).not.toContain(fixture.skillBody);
  expect(prompt).not.toContain(fixture.skillsRoot);
}
