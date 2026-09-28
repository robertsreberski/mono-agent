import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSchedulesCommand } from "../cli-schedules-command.js";
import { openTelegramScheduleStore } from "../telegram-schedule-store.js";

describe("mono-agent schedules", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-schedules-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(positionals: string[], json = false) {
    let stdout = "";
    let stderr = "";
    const code = await runSchedulesCommand({
      cwd: dir,
      positionals,
      ...(json ? { json: true } : {}),
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    return { code, stdout, stderr };
  }

  async function seed(): Promise<string> {
    const store = await openTelegramScheduleStore({ cwd: dir });
    const record = store.create({
      botId: "111",
      name: "Daily flight check",
      prompt: "Check fares.",
      timing: { kind: "cron", expression: "0 8 * * *", timezone: "Europe/Budapest" },
      destination: { chatId: "-1001", topicId: 77, label: "Trips › Flights" },
      producerConversationId: "telegram:-1001",
      nextRunAt: "2026-09-29T06:00:00.000Z",
    }, 20, "test");
    store.close();
    return record.id;
  }

  it("lists nothing when the agent has no schedules", async () => {
    await expect(run([])).resolves.toMatchObject({ code: 0, stdout: "No Telegram schedules.\n" });
    await expect(run(["list"], true)).resolves.toMatchObject({ code: 0 });
    expect(JSON.parse((await run(["list"], true)).stdout)).toEqual({ ok: true, schedules: [] });
  });

  it("lists schedules as text and JSON without the internal topic id", async () => {
    const id = await seed();
    const text = await run(["list"]);
    expect(text.stdout).toContain(`${id}  active  Daily flight check → Trips › Flights`);
    const json = JSON.parse((await run(["list"], true)).stdout) as { schedules: Array<Record<string, unknown>> };
    expect(json.schedules[0]).toMatchObject({ id, destination: "Trips › Flights", chatId: "-1001", status: "active" });
    expect(JSON.stringify(json)).not.toContain("77");
  });

  it("deletes only while the agent does not own the store", async () => {
    const id = await seed();
    const live = await openTelegramScheduleStore({ cwd: dir });
    try {
      const refused = await run(["delete", id]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("The agent is running");
      // Listing still works while the agent runs.
      expect((await run(["list"])).stdout).toContain(id);
    } finally {
      live.close();
    }
    await expect(run(["delete", id])).resolves.toMatchObject({ code: 0 });
    await expect(run(["delete", id])).resolves.toMatchObject({ code: 1 });
    expect((await run(["list"])).stdout).toBe("No Telegram schedules.\n");
  });

  it("rejects malformed usage", async () => {
    await expect(run(["delete"])).resolves.toMatchObject({ code: 2 });
    await expect(run(["list", "extra"])).resolves.toMatchObject({ code: 2 });
    await expect(run(["purge"])).resolves.toMatchObject({ code: 2 });
    await expect(run(["delete", "sch_1"], true)).resolves.toMatchObject({ code: 2 });
  });
});
