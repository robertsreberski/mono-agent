// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { defineFieldGroup } from "@worklab-ai/settings/field-groups";
import { OperatorConsoleClient, type PutResponse } from "../api.js";
import { ConfigForm } from "./ConfigForm.js";

const TEST_FIELD_GROUPS = [
  defineFieldGroup({
    id: "identity",
    label: "Identity",
    fields: [
      { id: "context.identityPath", label: "Identity document", kind: "path", required: true, path: ["context", "identityPath"] },
    ],
  }),
  defineFieldGroup({
    id: "runtime",
    label: "Runtime",
    fields: [
      { id: "runtime.model", label: "Model", kind: "string", path: ["runtime", "model"] },
      { id: "runtime.maxTurns", label: "Max turns", kind: "integer", min: 1, max: 100, path: ["runtime", "maxTurns"] },
    ],
  }),
  defineFieldGroup({
    id: "telegram",
    label: "Telegram",
    fields: [
      { id: "telegram.botToken", label: "Bot token", kind: "secret", path: ["telegram", "botToken"] },
    ],
  }),
];

function makeStubClient(overrides: Partial<OperatorConsoleClient> = {}): OperatorConsoleClient {
  const stub = new OperatorConsoleClient("", "test-token");
  return Object.assign(stub, overrides);
}

/**
 * Radix tabs respond to pointerdown rather than the synthetic click that
 * fireEvent.click dispatches in happy-dom. user-event simulates the full
 * pointer sequence so the controlled state actually toggles.
 */
async function clickTab(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name }));
}

describe("<ConfigForm/>", () => {
  it("renders every tab from the registry", () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );
    for (const group of TEST_FIELD_GROUPS) {
      expect(screen.getByRole("tab", { name: group.label })).toBeInTheDocument();
    }
  });

  it("renders the first group's fields by default", () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );
    expect(screen.getByLabelText(/Identity document/)).toBeInTheDocument();
  });

  it("switches tabs when clicking the Runtime tab", async () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );
    await clickTab("Runtime");
    expect(await screen.findByLabelText(/^Model/u)).toBeInTheDocument();
  });

  it("shows a SET badge for secrets that are already set", async () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {
            telegram: {
              // server sends the marker shape; the form treats it as a hint
              botToken: { __secret: true, set: true } as unknown as string,
            },
          },
          version: "v0",
        }}
      />,
    );
    await clickTab("Telegram");
    // Wait for the panel to render, then find the SET badge by its
    // accessible label. The badge sits inside the field's <Label>
    // alongside the field title text.
    await screen.findByText(/Bot token/);
    const badge = await screen.findByLabelText("secret is set");
    expect(badge).toHaveTextContent("SET");
  });

  it("edits a field, saves, and sends the patch with expectedVersion", async () => {
    const writeConfig = vi.fn<OperatorConsoleClient["writeConfig"]>().mockResolvedValue({
      ok: true,
      version: "v1",
    } satisfies PutResponse);
    const fetchConfig = vi.fn<OperatorConsoleClient["fetchConfig"]>().mockResolvedValue({
      config: { runtime: { maxTurns: 20 } },
      version: "v1",
    });
    const client = makeStubClient({ writeConfig, fetchConfig });
    render(
      <ConfigForm
        client={client}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: { runtime: { maxTurns: 8 } },
          version: "v0",
        }}
      />,
    );

    await clickTab("Runtime");
    const input = (await screen.findByLabelText(/Max turns/u)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20" } });

    expect(screen.getByText(/1 unsaved change/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // wait microtasks so the await chain in handleSave resolves
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeConfig).toHaveBeenCalledTimes(1);
    const args = writeConfig.mock.calls[0]?.[0];
    expect(args?.expectedVersion).toBe("v0");
    expect(args?.patch).toEqual({ runtime: { maxTurns: 20 } });
  });

  it.each([
    [
      "applied",
      {
        kind: "applied",
        message: "Reloaded running transports.",
        transports: ["telegram"],
      },
      "saved and applied",
      /Saved and applied/u,
    ],
    [
      "waiting",
      {
        kind: "waiting_for_config",
        message: "Waiting for valid Telegram config.",
        transports: ["operator-console"],
      },
      "saved waiting for config",
      /Saved; waiting for valid config/u,
    ],
    [
      "failed",
      {
        kind: "failed",
        message: "A2A port is already in use.",
        transports: ["operator-console"],
      },
      "saved apply failed",
      /Saved; apply failed/u,
    ],
  ] as const)("shows %s apply status after save", async (_name, apply, label, text) => {
    const writeConfig = vi.fn<OperatorConsoleClient["writeConfig"]>().mockResolvedValue({
      ok: true,
      version: "v1",
      apply,
    } satisfies PutResponse);
    const fetchConfig = vi.fn<OperatorConsoleClient["fetchConfig"]>().mockResolvedValue({
      config: { runtime: { maxTurns: 21 } },
      version: "v1",
    });
    const client = makeStubClient({ writeConfig, fetchConfig });
    render(
      <ConfigForm
        client={client}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: { runtime: { maxTurns: 8 } },
          version: "v0",
        }}
      />,
    );

    await clickTab("Runtime");
    const input = (await screen.findByLabelText(/Max turns/u)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByLabelText(label)).toHaveTextContent(text);
  });

  it("masks the secret input so typed values don't echo on screen", async () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );
    await clickTab("Telegram");
    const input = (await screen.findByLabelText(/Bot token/u)) as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("uses mobile-safe layout classes for overflowing tabs and the sticky save bar", () => {
    const { container } = render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: TEST_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );

    const root = container.firstElementChild;
    expect(root?.className).toContain("max-w-3xl");
    const tabs = screen.getByLabelText("Settings sections");
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).toContain("max-w-full");
    const saveBar = screen.getByRole("status");
    expect(saveBar.className).toContain("flex-col");
    expect(saveBar.className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("w-full");
  });
});
