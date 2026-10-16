

import type { BuildMonoAgentConfigViewInput, ConfigViewSection } from "./view/types.js";

import {
  buildAgentSection,
  buildConcurrencySection,
  buildContextSection,
  buildRuntimeSection,
} from "./view/runtime.js";

import { buildMemorySection } from "./view/memory.js";

import { buildSandboxSection, buildToolsSection } from "./view/tools.js";

import { buildArtifactsSection, buildTraceabilitySection } from "./view/artifacts.js";

import { buildProvidersSection } from "./view/providers.js";

/**
 * Build the single, complete, source-annotated view of a resolved
 * `MonoAgentConfig`. Every core section and field is represented exactly once,
 * including nested `providers` blocks that the
 * retired field-group registry omitted. Drives both the read-only TUI config
 * pane and the `mono-agent config` CLI command, so the two surfaces can never
 * disagree about what the loader produced.
 */
export function buildMonoAgentConfigView(
  input: BuildMonoAgentConfigViewInput,
): readonly ConfigViewSection[] {
  return [
    buildAgentSection(input),
    buildRuntimeSection(input),
    buildConcurrencySection(input),
    buildContextSection(input),
    buildMemorySection(input),
    buildToolsSection(input),
    buildSandboxSection(input),
    buildArtifactsSection(input),
    buildTraceabilitySection(input),
    buildProvidersSection(input),
  ];
}
