import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loginAnthropic,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPiOAuthLogin } from "../pi-oauth-login.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Pi OAuth terminal wrapper", () => {
  it("hands a pasted full redirect URL unchanged to the provider and preserves sibling credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-pi-oauth-wrapper-"));
    dirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ sibling: { type: "api_key", key: "keep" } })}\n`, { mode: 0o644 });

    const redirect = "http://localhost:53692/callback?code=test-code&state=expected-state";
    const questions: string[] = [];
    let received = "";
    const provider = {
      id: "anthropic",
      name: "Anthropic",
      usesCallbackServer: true,
      login: vi.fn(async (callbacks: OAuthLoginCallbacks) => {
        callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?state=expected-state" });
        received = await callbacks.onManualCodeInput!();
        const parsed = new URL(received);
        if (parsed.searchParams.get("state") !== "expected-state") throw new Error("OAuth state mismatch");
        if (parsed.searchParams.get("code") === null) throw new Error("Missing authorization code");
        return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
      }),
      refreshToken: vi.fn(),
      getApiKey: vi.fn(),
    } as unknown as OAuthProviderInterface;

    await runPiOAuthLogin("anthropic", {
      authPath,
      provider,
      io: {
        ask: async (question) => {
          questions.push(question);
          return redirect;
        },
        write: vi.fn(),
      },
    });

    expect(received).toBe(redirect);
    expect(questions).toEqual([expect.stringMatching(/OAuth state will be validated/u)]);
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      sibling: { type: "api_key", key: "keep" },
      anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: expect.any(Number) },
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps Anthropic's shipped code/state validation on the manual redirect path", async () => {
    await expect(loginAnthropic({
      onAuth: () => undefined,
      onPrompt: async () => "",
      onManualCodeInput: async () =>
        "http://localhost:53692/callback?code=untrusted-code&state=wrong-state",
    })).rejects.toThrow("OAuth state mismatch");
  });
});
