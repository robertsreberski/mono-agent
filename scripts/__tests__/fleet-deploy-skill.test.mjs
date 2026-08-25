import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const skillPath = "skills/fleet-deploy/SKILL.md";
const logHygieneSkillPath = "skills/ops-log-hygiene/SKILL.md";

describe("fleet-deploy skill", () => {
  it("adopts Personal Agent through a version-installing managed restart", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain('cd "$HOME/personal-agent"\nmono-agent restart');
    expect(skill).toContain("/.mono-agent/runtimes/agent-app/");
    expect(skill).toContain(
      "A raw\nkickstart only relaunches the snapshot already recorded in the plist",
    );
    expect(skill).not.toContain("launchctl kickstart -k");
    expect(skill).not.toContain("checkout-backed runtime");
  });

  it("uses the same managed-runtime provenance rule in log audits", async () => {
    const skill = await readFile(logHygieneSkillPath, "utf8");

    expect(skill).toContain(
      "Every managed `com.mono-agent.*` instance, including Personal Agent",
    );
    expect(skill).toContain("The checkout CLI version is not serving-");
    expect(skill).toContain("process provenance.");
    expect(skill).not.toContain("Personal Agent's checkout path");
  });
});
