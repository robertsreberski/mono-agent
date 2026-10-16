import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";

const source = async (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("app foundation dependency direction", () => {
  it("keeps platform commands independent of command-owned probes", async () => {
    const systemd = await source("systemd-command.ts");
    expect(systemd).not.toMatch(/["']\.\/(?:cli-background-command|web-command)\.js["']/u);
    expect(systemd).toContain("./service/start-preflight.js");
    expect(systemd).toContain("./service/web/health.js");
    expect(await source("service/web/health.ts")).not.toContain("web-command.js");
  });

  it("keeps durable source readers independent of first-run orchestration", async () => {
    expect(await source("background-snapshot.ts")).not.toContain("first-run-readiness.js");
    const inputs = await source("service/background/source-inputs.ts");
    expect(inputs).not.toMatch(/doctor|wizard|provider-setup|first-run/u);
    expect(inputs).toContain("O_NOFOLLOW");
    expect(inputs).toContain("O_NONBLOCK");
  });

  it("uses leaf contracts for validation and maintenance", async () => {
    for (const file of ["ui.ts", "modules/types.ts"]) {
      expect(await source(file)).not.toMatch(/from ["'](?:\.\.\/|\.\/)doctor\.js["']/u);
    }
    expect(await source("background-log-maintenance.ts")).not.toMatch(/from ["']\.\/background\.js["']/u);
    expect(await source("launchd-log-monitor-status.ts")).not.toContain("background-log-maintenance.js");
  });
});

it("keeps domain contracts erased and independent of their implementation", async () => {
  for (const file of ["channels/types.ts", "memory/recall-contract.ts", "subagents/types.ts"]) {
    const text = await source(file);
    expect(text).not.toMatch(/^import (?!type\b)/mu);
    expect(text).not.toMatch(/from ["'][^"']*(?:channels|memory-recall|memory-guidance|memory-label-sections|subagent-instances|subagent-execution-ownership|subagent-command-receipts)\.js["']/u);
  }
});
