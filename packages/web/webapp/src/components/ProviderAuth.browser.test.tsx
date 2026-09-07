import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { agent } from "../test/fixtures";
import "../styles.css";

const storeMock = vi.hoisted(() => ({
  selectedAgent: null as ReturnType<typeof agent> | null,
  catalogByProvider: {},
  ensureProviderCatalog: vi.fn(),
  setAgentRunDefaults: vi.fn(),
  clearAgentRunDefaults: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({
  providerAuthStatus: vi.fn(),
  beginProviderAuth: vi.fn(),
  providerAuthSession: vi.fn(),
  submitProviderAuth: vi.fn(),
  cancelProviderAuth: vi.fn(),
  beginProviderAuthCheck: vi.fn(),
  providerAuthCheck: vi.fn(),
  cancelProviderAuthCheck: vi.fn(),
}));

vi.mock("../console-store", () => ({ useConsoleStore: () => storeMock }));
vi.mock("../api", () => ({ api: apiMock }));
vi.mock("./assistant-ui/ModelSelector", () => ({ ModelSelector: () => null }));

import { AgentSettingsDialog } from "./AgentSettingsDialog";

const providers = [
  { providerId: "fixture-pass", label: "Fixture pass", model: "fixture-pass:cheap" },
  { providerId: "fixture-auth", label: "Fixture auth", model: "fixture-auth:cheap" },
  { providerId: "fixture-quota", label: "Fixture quota", model: "fixture-quota:cheap" },
];

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.selectedAgent = agent("alpha", {
    label: "Alpha",
    supportsProviderAuth: true,
    supportsProviderAuthChecks: true,
  });
  apiMock.providerAuthStatus.mockResolvedValue({
    schema: "mono-agent.provider-auth.v1",
    generatedAt: "2026-09-06T12:00:00.000Z",
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label,
      usages: [{ kind: "primary", model: provider.model, label: "Model" }],
      state: "present",
      source: "stored",
      verification: "not_verified",
      methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "API key", recommended: true }],
    })),
  });
  apiMock.beginProviderAuthCheck.mockResolvedValue({
    schema: "mono-agent.provider-auth-check.v1",
    id: "check-one",
    state: "completed",
    createdAt: "2026-09-06T12:00:00.000Z",
    updatedAt: "2026-09-06T12:00:01.000Z",
    expiresAt: "2026-09-06T12:10:01.000Z",
    results: [
      { providerId: "fixture-pass", label: "Fixture pass", state: "passed", model: "fixture-pass:cheap", selectionBasis: "catalog_pricing", checkedAt: "2026-09-06T12:00:01.000Z", code: "passed", message: "Provider request succeeded." },
      { providerId: "fixture-auth", label: "Fixture auth", state: "auth_failed", model: "fixture-auth:cheap", selectionBasis: "catalog_pricing", checkedAt: "2026-09-06T12:00:01.000Z", code: "credential_rejected", message: "Provider rejected the configured credential." },
      { providerId: "fixture-quota", label: "Fixture quota", state: "quota_limited", model: "fixture-quota:cheap", selectionBasis: "catalog_pricing", checkedAt: "2026-09-06T12:00:01.000Z", code: "quota_limited", message: "Provider quota or rate limit prevented the check." },
    ],
  });
  apiMock.cancelProviderAuth.mockResolvedValue(undefined);
  apiMock.cancelProviderAuthCheck.mockResolvedValue(undefined);
});

describe("provider authentication controls in Chromium", () => {
  it("keeps recovery normal-size and neutral while one explicit faux batch reports distinct outcomes", async () => {
    render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findAllByText("Not verified")).toHaveLength(3);
    expect(screen.queryByText("OK")).not.toBeInTheDocument();
    const recovery = screen.getAllByRole("button", { name: "Re-authenticate" });
    expect(recovery).toHaveLength(3);
    expect(recovery.every((button) => button.classList.contains("provider-auth-neutral-button"))).toBe(true);
    expect(recovery.every((button) => button.getBoundingClientRect().height >= 38)).toBe(true);

    const run = screen.getByRole("button", { name: "Run live checks for all displayed providers" });
    expect(run.classList.contains("provider-auth-neutral-button")).toBe(true);
    expect(run.getBoundingClientRect().height).toBeGreaterThanOrEqual(38);
    await userEvent.click(run);

    await waitFor(() => expect(apiMock.beginProviderAuthCheck).toHaveBeenCalledOnce());
    expect(await screen.findByText("Check passed")).toBeVisible();
    expect(screen.getByText("Auth failed")).toBeVisible();
    expect(screen.getByText("Quota blocked")).toBeVisible();
    expect(screen.getByText("Checks complete: 1 of 3 passed.")).toBeVisible();
    expect(apiMock.providerAuthCheck).not.toHaveBeenCalled();
  });

  it.each([
    { width: 1_440, height: 900, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("restarts a long-running flow compactly at the $label viewport", async ({ width, height }) => {
    await page.viewport(width, height);
    const methods = [
      { authType: "oauth", strategy: "paste_back", label: "OAuth paste-back", recommended: true },
      { authType: "api_key", strategy: "api_key_prompt", label: "API key", recommended: false },
    ] as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "fixture-auth", label: "Fixture auth",
        usages: [{ kind: "primary", model: "fixture-auth:cheap", label: "Model" }],
        state: "present", source: "stored", verification: "not_verified", methods,
      }],
    });
    const active = {
      schema: "mono-agent.provider-auth-session.v1", id: "old-session", providerId: "fixture-auth",
      authType: "oauth", strategy: "paste_back", state: "awaiting_user",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:20:00.000Z", progress: "OLD FLOW ACTIVE",
    } as const;
    const replacement = deferred<Record<string, unknown>>();
    apiMock.beginProviderAuth.mockResolvedValueOnce(active).mockImplementationOnce(async () => await replacement.promise);
    let replacementPolls = 0;
    apiMock.providerAuthSession.mockImplementation(async (_sourceId: string, sessionId: string) => {
      if (sessionId === active.id) return active;
      replacementPolls += 1;
      return replacementPolls < 2
        ? { ...active, id: "new-session", authType: "api_key", strategy: "api_key_prompt", state: "pending", progress: "NEW FLOW ACTIVE" }
        : { ...active, id: "new-session", authType: "api_key", strategy: "api_key_prompt", state: "succeeded", progress: "NEW FLOW COMPLETE" };
    });
    const rendered = render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Re-authenticate" }));
    await userEvent.click(screen.getByRole("button", { name: "OAuth paste-back" }));
    expect(await screen.findByText("OLD FLOW ACTIVE")).toBeVisible();
    const restart = screen.getByRole("button", { name: "Re-authenticate" });
    expect(restart.getBoundingClientRect().height).toBeGreaterThanOrEqual(38);
    expect(restart.classList.contains("provider-auth-neutral-button")).toBe(true);

    await userEvent.click(restart);
    expect(screen.getByRole("button", { name: "OAuth paste-back" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "API key" }));
    expect(screen.getByText("Restarting authentication…")).toBeVisible();
    expect(screen.getByText("OLD FLOW ACTIVE")).toBeVisible();
    replacement.resolve({ ...active, id: "new-session", authType: "api_key", strategy: "api_key_prompt", state: "pending", progress: "NEW FLOW ACTIVE" });
    expect(await screen.findByText("NEW FLOW ACTIVE")).toBeVisible();
    expect(screen.queryByText("OLD FLOW ACTIVE")).not.toBeInTheDocument();
    expect(await screen.findByText("NEW FLOW COMPLETE", {}, { timeout: 3_000 })).toBeVisible();
    expect(replacementPolls).toBe(2);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    rendered.unmount();
  }, 5_000);

  it.each([
    { width: 1_440, height: 900, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("releases an expired live check at the $label viewport", async ({ width, height }) => {
    await page.viewport(width, height);
    const running = {
      schema: "mono-agent.provider-auth-check.v1", id: "expired-check", state: "running",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T12:10:00.000Z",
      results: [{
        providerId: "fixture-pass", label: "Fixture pass", state: "running",
        model: "fixture-pass:cheap", selectionBasis: "catalog_pricing",
      }],
    } as const;
    apiMock.beginProviderAuthCheck.mockResolvedValue(running);
    apiMock.providerAuthCheck.mockRejectedValue(Object.assign(new Error("expired"), {
      status: 404, code: "provider_auth_not_found",
    }));
    const rendered = render(<AgentSettingsDialog open onClose={() => undefined} dialogRef={createRef<HTMLElement>()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Run live checks for all displayed providers" }));
    expect(await screen.findByRole("button", { name: "Cancel live provider checks" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "Run live checks for all displayed providers" }, { timeout: 2_000 })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(apiMock.providerAuthCheck).toHaveBeenCalledOnce();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    rendered.unmount();
  }, 4_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
