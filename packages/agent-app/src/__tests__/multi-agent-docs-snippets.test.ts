import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  formatDiagnostics,
  getPreEmitDiagnostics,
  parseJsonConfigFileContent,
  readConfigFile,
  sys,
  type CompilerOptions,
  type Diagnostic,
} from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this test until the pnpm workspace root. */
function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

const root = repoRoot();

const cases = [
  {
    label: "composer playbook Multi-agent orchestration",
    docPath: "packages/agent-app/skills/mono-agent-composer/references/playbooks.md",
    heading: "8. Multi-agent orchestration (`AskCollaborator`) — code",
    prelude: `
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";

declare const config: MonoAgentConfig;
declare const researcher: AgentResponder;
declare const writer: AgentResponder;
`,
  },
  {
    label: "playbook Configuration",
    docPath: "docs/playbooks/multi-agent-orchestration.md",
    heading: "Configuration",
    prelude: `
import { createConfiguredAgentResponder } from "@mono-agent/agent-app";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createCollaboratorToolRuntimeExtension } from "@mono-agent/agent-orchestrator";

declare const config: MonoAgentConfig;
declare const researcherResponder: AgentResponder;
declare const writerResponder: AgentResponder;
`,
  },
  {
    label: "programmatic Wiring into the orchestrator",
    docPath: "docs/programmatic/multi-agent.md",
    heading: "Wiring into the orchestrator",
    prelude: `
import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

declare const researcherUrl: string;
declare const workerUrl: string;
declare const timeoutMs: number;
declare const orchestratorCoreConfig: MonoAgentConfig;
declare const orchestratorRuntime: MonoRuntimeLike;
`,
  },
] as const;

describe("multi-agent documentation snippets", () => {
  for (const testCase of cases) {
    it(`type-checks the complete ${testCase.label} snippet against exported APIs`, () => {
      const absoluteDocPath = join(root, testCase.docPath);
      const markdown = readFileSync(absoluteDocPath, "utf8");
      const snippet = typescriptSnippet(markdownSection(markdown, testCase.heading), testCase.docPath);
      expectRequestScopedCollaboratorLifecycle(snippet, testCase.docPath);
      const source = `
import type { AgentResponder as ExpectedAgentResponder } from "@mono-agent/agent-contracts";
${testCase.prelude}
${snippet}
const expectedOrchestrator: ExpectedAgentResponder = orchestrator;
void expectedOrchestrator;
`;
      const diagnostics = typecheck(source, join(dirname(absoluteDocPath), ".multi-agent-snippet.typecheck.ts"));

      expect(format(diagnostics), `${testCase.docPath} has a stale TypeScript snippet`).toBe("");
    });
  }
});

function expectRequestScopedCollaboratorLifecycle(snippet: string, docPath: string): void {
  const lifecycleFragments = [
    "runtimeOptionsForRequest: async (input) => {",
    "const extension = await createCollaboratorToolRuntimeExtension({",
    "conversationId: input.request.conversationId",
    "originalUserMessage: input.request.userMessage",
    "abortSignal: input.request.abortSignal",
    "return { runtimeOptions: extension.runtimeOptions, cleanup: extension.cleanup };",
  ] as const;
  for (const fragment of lifecycleFragments) {
    expect(snippet, `${docPath} must preserve request-scoped collaborator lifecycle wiring`).toContain(fragment);
  }
}

function markdownSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing "${marker}" section`);
  }
  const rest = markdown.slice(start + marker.length);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
}

function typescriptSnippet(section: string, docPath: string): string {
  const matches = [...section.matchAll(/```ts\n([\s\S]*?)\n```/gu)];
  if (matches.length !== 1) {
    throw new Error(
      `${docPath} must have exactly one TypeScript block in the checked section; found ${matches.length}`,
    );
  }
  return matches[0]?.[1] ?? "";
}

function compilerOptions(): CompilerOptions {
  const configPath = join(root, "tsconfig.base.json");
  const loaded = readConfigFile(configPath, sys.readFile);
  if (loaded.error !== undefined) {
    throw new Error(format([loaded.error]));
  }
  const parsed = parseJsonConfigFileContent(
    loaded.config,
    sys,
    root,
    { noEmit: true, types: ["node"] },
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(format(parsed.errors));
  }
  return parsed.options;
}

function typecheck(source: string, virtualPath: string) {
  const options = compilerOptions();
  const host = createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) => fileName === virtualPath || sys.fileExists(fileName);
  host.readFile = (fileName) => fileName === virtualPath ? source : sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === virtualPath
      ? createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  return getPreEmitDiagnostics(createProgram([virtualPath], options, host));
}

function format(diagnostics: readonly Diagnostic[]): string {
  return formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => relative(root, fileName),
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
}
