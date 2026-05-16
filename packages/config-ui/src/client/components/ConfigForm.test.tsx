// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CORE_FIELD_GROUPS } from "../../schema/field-group.js";
import { ConfigUiClient, type PutResponse } from "../api.js";
import { ConfigForm } from "./ConfigForm.js";

function makeStubClient(overrides: Partial<ConfigUiClient> = {}): ConfigUiClient {
  const stub = new ConfigUiClient("", "test-token");
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
          fieldGroups: CORE_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );
    for (const group of CORE_FIELD_GROUPS) {
      expect(screen.getByRole("tab", { name: group.label })).toBeInTheDocument();
    }
  });

  it("renders the first group's fields by default", () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: CORE_FIELD_GROUPS,
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
          fieldGroups: CORE_FIELD_GROUPS,
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
          fieldGroups: CORE_FIELD_GROUPS,
          config: {
            telegram: {
              // bridge sends the marker shape; the form treats it as a hint
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
    const writeConfig = vi.fn<ConfigUiClient["writeConfig"]>().mockResolvedValue({
      ok: true,
      version: "v1",
    } satisfies PutResponse);
    const fetchConfig = vi.fn<ConfigUiClient["fetchConfig"]>().mockResolvedValue({
      config: { runtime: { maxTurns: 20 } },
      version: "v1",
    });
    const client = makeStubClient({ writeConfig, fetchConfig });
    render(
      <ConfigForm
        client={client}
        initial={{
          fieldGroups: CORE_FIELD_GROUPS,
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

  it("masks the secret input so typed values don't echo on screen", async () => {
    render(
      <ConfigForm
        client={makeStubClient()}
        initial={{
          fieldGroups: CORE_FIELD_GROUPS,
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
          fieldGroups: CORE_FIELD_GROUPS,
          config: {},
          version: "v0",
        }}
      />,
    );

    const root = container.firstElementChild;
    expect(root?.className).toContain("max-w-3xl");
    const tabs = screen.getByLabelText("Configuration sections");
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).toContain("max-w-full");
    const saveBar = screen.getByRole("status");
    expect(saveBar.className).toContain("flex-col");
    expect(saveBar.className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("w-full");
  });
});
