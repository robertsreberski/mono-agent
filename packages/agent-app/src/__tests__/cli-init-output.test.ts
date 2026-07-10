import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { initChangeDisplayRows, secretChecklistDisplayRows } from "../cli.js";
import { initMonoAgentFolder } from "../init.js";
import { defaultAnswers } from "../wizard/answers.js";

describe("init result reporting", () => {
  it("reports dry-run creates/updates and configured names without exposing values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-init-output-"));
    const token = "top-secret-value";
    try {
      const result = await initMonoAgentFolder({
        dir,
        dryRun: true,
        answers: defaultAnswers({
          channels: ["channel:telegram"],
          moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
        }),
        secretValues: { MONO_AGENT_TELEGRAM_BOT_TOKEN: token },
      });
      const changes = initChangeDisplayRows(result);
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: "would create", path: join(dir, ".env") }),
        expect.objectContaining({ label: "would create", path: join(dir, ".gitignore") }),
      ]));
      expect(JSON.stringify(changes)).not.toContain(token);

      const configured = secretChecklistDisplayRows(
        result.plan.secrets,
        new Set(["MONO_AGENT_TELEGRAM_BOT_TOKEN"]),
      );
      expect(configured).toContainEqual(expect.objectContaining({
        envVar: "MONO_AGENT_TELEGRAM_BOT_TOKEN",
        status: "configured",
      }));
      expect(JSON.stringify(configured)).not.toContain(token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks an unconfigured required secret as missing", () => {
    const plan = defaultAnswers({ channels: ["channel:telegram"] });
    // The display helper consumes the public checklist shape; no secret value is accepted.
    const rows = secretChecklistDisplayRows([
      {
        moduleId: "channel:telegram",
        label: "Telegram bot token",
        envVar: "MONO_AGENT_TELEGRAM_BOT_TOKEN",
        description: "Bot API token.",
        required: true,
      },
    ], new Set());
    expect(plan.channels).toContain("channel:telegram");
    expect(rows[0]?.status).toBe("missing");
  });
});
