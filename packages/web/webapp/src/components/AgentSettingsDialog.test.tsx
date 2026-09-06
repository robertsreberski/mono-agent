import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
}));

vi.mock("../console-store", () => ({ useConsoleStore: () => storeMock }));
vi.mock("../api", () => ({ api: apiMock }));
vi.mock("./assistant-ui/ModelSelector", () => ({
  ModelSelector: ({ onValueChange, onEffortChange }: {
    readonly onValueChange: (value: string) => void;
    readonly onEffortChange: (value: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onValueChange("provider/other")}>Choose other model</button>
      <button type="button" onClick={() => onEffortChange("high")}>Choose high effort</button>
    </div>
  ),
}));

import { AgentSettingsDialog } from "./AgentSettingsDialog";

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.selectedAgent = agent("alpha", {
    label: "Alpha",
    models: ["provider/model", "provider/other"],
    modelOptions: {
      "provider/model": { effortLevels: ["low", "high"] },
      "provider/other": { effortLevels: ["low", "high"] },
    },
  });
  storeMock.setAgentRunDefaults.mockResolvedValue(undefined);
  storeMock.clearAgentRunDefaults.mockResolvedValue(undefined);
  apiMock.cancelProviderAuth.mockResolvedValue(undefined);
});

describe("AgentSettingsDialog", () => {
  it("labels current config sources and saves only future-conversation defaults", async () => {
    const close = vi.fn();
    render(<AgentSettingsDialog open onClose={close} dialogRef={createRef<HTMLElement>()} />);

    expect(screen.getByRole("dialog", { name: "Alpha settings" })).toBeVisible();
    expect(screen.getByText(/Existing conversations and other channels are unchanged/u)).toBeVisible();
    expect(screen.getAllByText("config")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Choose other model" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose high effort" }));
    fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));

    await vi.waitFor(() => {
      expect(storeMock.setAgentRunDefaults).toHaveBeenCalledWith("provider/other", "high");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("makes the normal settings body the dialog scroll boundary", () => {
    const { container } = render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);
    const dialog = container.querySelector(".agent-settings-dialog");
    const body = container.querySelector(".agent-settings-body");

    expect(dialog?.children[1]).toBe(body);
    expect(window.getComputedStyle(body!).overflowY).toBe("auto");
  });

  it("reverts an active override with one click", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      runSettings: {
        config: { model: "provider/model", effort: "low" },
        override: { model: "provider/other", effort: "high" },
        effective: {
          model: "provider/other",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Revert to config" }));

    await vi.waitFor(() => expect(storeMock.clearAgentRunDefaults).toHaveBeenCalledOnce());
  });

  it("renders compact provider status rows and clears a masked key before submitting it", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const missingStatus = {
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "opencode-go", label: "OpenCode Go",
        usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
        state: "missing", verification: "not_verified",
        methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true }],
      }],
    };
    apiMock.providerAuthStatus.mockResolvedValueOnce(missingStatus).mockResolvedValue({
      ...missingStatus,
      generatedAt: "2026-09-06T12:00:01.000Z",
      providers: [{ ...missingStatus.providers[0], state: "present", credentialType: "api_key", source: "stored" }],
    });
    const awaiting = {
      schema: "mono-agent.provider-auth-session.v1", id: "session-1", providerId: "opencode-go",
      authType: "api_key", strategy: "api_key_prompt", state: "awaiting_input",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:00.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      prompt: { id: "prompt-1", type: "secret", message: "Enter the OpenCode API key" },
    };
    apiMock.beginProviderAuth.mockResolvedValue(awaiting);
    apiMock.submitProviderAuth.mockImplementation(async () => {
      expect(screen.getByLabelText("Enter the OpenCode API key")).toHaveValue("");
      return { ...awaiting, state: "succeeded", prompt: undefined, updatedAt: "2026-09-06T12:00:01.000Z" };
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("Needs action")).toBeVisible();
    expect(screen.getByText("OpenCode Go")).toBeVisible();
    expect(screen.queryByText("opencode-go")).not.toBeInTheDocument();
    expect(screen.queryByText(/Used by/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/No credential detected/u)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    const key = await screen.findByLabelText("Enter the OpenCode API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    fireEvent.change(key, { target: { value: "PROVIDER_AUTH_SECRET_SENTINEL" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));

    await vi.waitFor(() => expect(apiMock.submitProviderAuth).toHaveBeenCalledWith(
      "alpha", "session-1", { promptId: "prompt-1", value: "PROVIDER_AUTH_SECRET_SENTINEL" },
    ));
    expect(document.body.textContent).not.toContain("PROVIDER_AUTH_SECRET_SENTINEL");
    expect(await screen.findByRole("button", { name: "Close authentication" })).toBeVisible();
    await vi.waitFor(() => expect(apiMock.providerAuthStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("OK")).toBeVisible();
  });

  it("uses status-only rows and limits actions to actionable providers", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [
        {
          providerId: "openai", label: "OpenAI", usages: [{ kind: "primary", model: "openai:gpt-5", label: "Primary model" }],
          state: "present", source: "environment", verification: "verified_by_live_request", methods: [],
        },
        {
          providerId: "copilot", label: "GitHub Copilot", usages: [{ kind: "fallback", model: "github-copilot:gpt-5", label: "Fallback model" }],
          state: "missing", verification: "not_verified",
          methods: [{ authType: "oauth", strategy: "device_code", label: "GitHub device code", recommended: true }],
        },
        {
          providerId: "local", label: "Local model", usages: [{ kind: "primary", model: "ollama:llama", label: "Primary model" }],
          state: "not_applicable", verification: "not_applicable", methods: [],
        },
      ],
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("OK")).toBeVisible();
    expect(screen.getByText("Needs action")).toBeVisible();
    expect(screen.getByText("Not applicable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Authenticate" })).toBeVisible();
    expect(screen.queryByText("openai")).not.toBeInTheDocument();
    expect(screen.queryByText("environment")).not.toBeInTheDocument();
    expect(screen.queryByText(/Primary model/u)).not.toBeInTheDocument();
  });

  it("starts OpenAI device code directly and offers paste-back only after it is unavailable", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const methods = [
      { authType: "oauth", strategy: "device_code", label: "OpenAI Codex (device code)", recommended: true },
      { authType: "oauth", strategy: "paste_back", label: "OpenAI Codex (paste redirect)", recommended: false },
    ] as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "openai-codex", label: "OpenAI Codex",
        usages: [{ kind: "primary", model: "openai-codex:gpt-5.6-terra", label: "Primary model" }],
        state: "missing", verification: "not_verified", methods,
      }],
    });
    const failed = {
      schema: "mono-agent.provider-auth-session.v1", id: "session-openai", providerId: "openai-codex",
      authType: "oauth", strategy: "device_code", state: "failed",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:01.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      error: { code: "device_code_unavailable", message: "Device-code authentication is unavailable; retry with browser paste-back." },
    };
    apiMock.beginProviderAuth.mockResolvedValueOnce(failed).mockResolvedValueOnce({
      ...failed, id: "session-paste", strategy: "paste_back", state: "pending", error: undefined,
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    await vi.waitFor(() => expect(apiMock.beginProviderAuth).toHaveBeenNthCalledWith(
      1, "alpha", "openai-codex", methods[0],
    ));
    const retry = await screen.findByRole("button", { name: "Retry with browser paste-back" });
    expect(screen.queryByText("Choose how to authenticate OpenAI Codex")).not.toBeInTheDocument();
    fireEvent.click(retry);
    await vi.waitFor(() => expect(apiMock.beginProviderAuth).toHaveBeenNthCalledWith(
      2, "alpha", "openai-codex", methods[1],
    ));
  });

  it("renders paste-back instructions as a safe external link and cancels an active session on close", async () => {
    storeMock.selectedAgent = agent("alpha", { label: "Alpha", supportsProviderAuth: true });
    const method = { authType: "oauth", strategy: "paste_back", label: "Anthropic OAuth", recommended: true } as const;
    apiMock.providerAuthStatus.mockResolvedValue({
      schema: "mono-agent.provider-auth.v1",
      generatedAt: "2026-09-06T12:00:00.000Z",
      providers: [{
        providerId: "anthropic", label: "Anthropic",
        usages: [{ kind: "primary", model: "anthropic:claude-sonnet-4-5", label: "Primary model" }],
        state: "expired", credentialType: "oauth", source: "stored", expiresAt: "2026-09-06T11:00:00.000Z",
        verification: "not_verified", methods: [method],
        lastFailure: { kind: "provider_auth", message: "Provider rejected the configured credential.", model: "anthropic:claude-sonnet-4-5", observedAt: "2026-09-06T11:30:00.000Z" },
      }],
    });
    apiMock.beginProviderAuth.mockResolvedValue({
      schema: "mono-agent.provider-auth-session.v1", id: "session-anthropic", providerId: "anthropic",
      authType: "oauth", strategy: "paste_back", state: "awaiting_input",
      createdAt: "2026-09-06T12:00:00.000Z", updatedAt: "2026-09-06T12:00:01.000Z", expiresAt: "2026-09-06T12:20:00.000Z",
      authUrl: {
        url: "https://console.anthropic.com/oauth/authorize",
        instructions: "If localhost cannot load, copy the complete final URL and paste it here.",
      },
      prompt: { id: "prompt-anthropic", type: "manual_code", message: "Paste the redirect URL" },
    });
    const rendered = render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(await screen.findByText("Needs action")).toBeVisible();
    expect(screen.queryByText("expired")).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider rejected the configured credential/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    const link = await screen.findByRole("link", { name: "Open authentication page" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/copy the complete final URL/u)).toBeVisible();
    expect(link.closest(".provider-auth-flow")).toHaveAttribute("aria-live", "polite");
    rendered.unmount();
    await vi.waitFor(() => expect(apiMock.cancelProviderAuth).toHaveBeenCalledWith(
      "alpha", "session-anthropic", expect.any(AbortSignal),
    ));
  });

  it("keeps an unsupported provider-auth capability terse", () => {
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    expect(screen.getByText("Not available on this agent.")).toBeVisible();
    expect(screen.queryByText(/does not expose the protected provider-authentication capability/u)).not.toBeInTheDocument();
  });
});
