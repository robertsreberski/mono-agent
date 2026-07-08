import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MODULES,
  findModule,
  modulesByKind,
  resolveModuleInputs,
} from "../modules/index.js";

const MODEL = "claude:claude-sonnet-4-6";

/** Section ids the doctor emits — a `channel:<driver>` id or one of the fixed sections. */
const FIXED_SECTION_IDS = new Set(["runtime", "memory", "sandbox", "tools", "observability"]);
function isValidSectionId(id: string): boolean {
  return FIXED_SECTION_IDS.has(id) || id.startsWith("channel:");
}

describe("capability-module catalog", () => {
  it("is non-empty with unique ids", () => {
    expect(CAPABILITY_MODULES.length).toBeGreaterThan(0);
    const ids = CAPABILITY_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findModule resolves every catalog id and rejects unknown ids", () => {
    for (const module of CAPABILITY_MODULES) {
      expect(findModule(module.id)?.id).toBe(module.id);
    }
    expect(findModule("does-not-exist")).toBeUndefined();
  });

  it("every module's configFragment returns an object and never leaks a secret value", () => {
    for (const module of CAPABILITY_MODULES) {
      const fragment = module.configFragment(resolveModuleInputs(module, { model: MODEL }));
      expect(typeof fragment).toBe("object");
      expect(fragment).not.toBeNull();
      expect(JSON.stringify(fragment)).not.toMatch(/xoxb-|xapp-|sk-[A-Za-z0-9]/u);
    }
  });

  it("every module declares at least one validate expectation with a valid section id", () => {
    for (const module of CAPABILITY_MODULES) {
      expect(module.validateExpectations.length).toBeGreaterThanOrEqual(1);
      for (const expectation of module.validateExpectations) {
        expect(isValidSectionId(expectation.sectionId)).toBe(true);
      }
    }
  });

  it("threads the composer-supplied model into the memory:bujo LLM", () => {
    const module = findModule("memory:bujo");
    expect(module).toBeDefined();
    const fragment = module!.configFragment(resolveModuleInputs(module!, { model: MODEL }));
    expect(fragment.memory?.llm?.model).toBe(MODEL);
  });

  it("configures a native fail-closed sandbox that mentions srt", () => {
    const module = findModule("sandbox");
    expect(module).toBeDefined();
    const fragment = module!.configFragment(resolveModuleInputs(module!, { model: MODEL }));
    expect(fragment.sandbox?.mode).toBe("native");
    expect(fragment.sandbox?.fallback).toBe("fail-closed");
    const note = module!.validateExpectations.find((e) => e.sectionId === "sandbox")?.note ?? "";
    expect(note).toContain("srt");
  });

  it("scaffolds a cron/digest.md carrying the resolved cron expression", () => {
    const module = findModule("channel:cron");
    expect(module).toBeDefined();
    const values = resolveModuleInputs(module!, { model: MODEL, cronExpression: "30 7 * * 1-5" });
    const files = module!.files?.(values) ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("cron/digest.md");
    expect(files[0]?.contents).toContain("30 7 * * 1-5");
  });

  it("groups modules by kind: exactly 2 providers and 6 channels", () => {
    const providers = modulesByKind("provider");
    expect(providers.map((m) => m.id).sort()).toEqual(["provider:lmstudio", "provider:ollama"]);
    expect(modulesByKind("channel")).toHaveLength(6);
  });
});
