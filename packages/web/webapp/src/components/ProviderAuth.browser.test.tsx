import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
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
      { providerId: "fixture-quota", label: "Fixture quota", state: "quota_limited", model: "fixture-quota:cheap", selectionBasis: "catalog_pricing", checkedAt: "2026-09-06T12:00:01.000Z", code: "quota_limited", message: "Provider quota prevented the check." },
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
});
