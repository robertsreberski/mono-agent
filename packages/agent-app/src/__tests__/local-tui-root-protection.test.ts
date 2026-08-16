import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const responderState = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("../configured-agent.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../configured-agent.js")>(),
  createConfiguredAgentResponderForApp: responderState.create,
}));

const { initMonoAgentFolder } = await import("../init.js");
const { createLocalConfigurationSession } = await import("../local-configuration.js");
const { defaultAnswers } = await import("../wizard/answers.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  responderState.create.mockReset();
  responderState.dispose.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("local TUI agent-root protection", () => {
  it("constructs the configured responder with the authenticated local cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-local-tui-root-"));
    temporaryDirectories.push(dir);
    const initialized = await initMonoAgentFolder({
      dir,
      answers: defaultAnswers({ name: "Root Test", purpose: "Verify the local TUI root." }),
    });
    responderState.create.mockResolvedValue({
      respond: vi.fn(),
      dispose: responderState.dispose,
    });

    const session = await createLocalConfigurationSession({
      cwd: dir,
      configPath: initialized.configPath,
      env: {},
      configure: false,
    });

    expect(responderState.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: await realpath(dir) }),
      {},
    );
    await session.dispose();
    expect(responderState.dispose).toHaveBeenCalledOnce();
  });
});
