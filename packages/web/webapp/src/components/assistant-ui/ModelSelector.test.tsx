import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ModelSelector,
  type ModelSelectorOption,
} from "./ModelSelector";

const efforts = [
  { id: "", name: "Default · High" },
  { id: "low", name: "Low" },
  { id: "high", name: "High" },
] as const;

const models: readonly ModelSelectorOption[] = [
  {
    id: "",
    name: "Default model",
    description: "Use the agent default",
    efforts,
  },
  {
    id: "pi:openai-codex:gpt-5.5",
    name: "GPT-5.5 Codex",
    description: "Most capable",
    efforts,
  },
  {
    id: "pi:anthropic:claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    efforts: efforts.slice(0, 2),
  },
];

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function ControlledSelector() {
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  return (
    <ModelSelector
      models={models}
      value={model}
      effort={effort}
      onValueChange={setModel}
      onEffortChange={setEffort}
    />
  );
}

function ExternallyOpenedSelector() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open run settings
      </button>
      <ModelSelector
        models={models}
        value=""
        effort=""
        onValueChange={() => undefined}
        onEffortChange={() => undefined}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

describe("ModelSelector", () => {
  it("renders the caller-supplied default option and searches model names", async () => {
    render(<ControlledSelector />);

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const popup = await screen.findByRole("dialog", {
      name: "Model and reasoning effort",
    });
    expect(document.body).toContainElement(popup);
    expect(within(popup).getByRole("option", { name: /Default model/u })).toHaveAttribute(
      "data-model-selected",
      "true",
    );
    expect(
      within(popup).getByRole("option", { name: /Default model/u }).querySelector(
        "[data-slot='model-selector-selected-indicator']",
      ),
    ).not.toBeNull();

    const search = within(popup).getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "anthropic" } });

    expect(within(popup).getByRole("option", { name: /Claude Sonnet 4\.5/u })).toBeVisible();
    expect(within(popup).queryByRole("option", { name: /GPT-5\.5 Codex/u })).toBeNull();
  });

  it("selects a model and then exposes that model's effort radio group", async () => {
    const onValueChange = vi.fn();
    const onEffortChange = vi.fn();
    const { rerender } = render(
      <ModelSelector
        models={models}
        value=""
        effort=""
        onValueChange={onValueChange}
        onEffortChange={onEffortChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    fireEvent.click(await screen.findByRole("option", { name: /GPT-5\.5 Codex/u }));
    expect(onValueChange).toHaveBeenCalledWith("pi:openai-codex:gpt-5.5");
    expect(screen.queryByRole("dialog", { name: "Model and reasoning effort" })).toBeNull();

    rerender(
      <ModelSelector
        models={models}
        value="pi:openai-codex:gpt-5.5"
        effort=""
        onValueChange={onValueChange}
        onEffortChange={onEffortChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const effortGroup = await screen.findByRole("radiogroup", { name: "Reasoning effort" });
    fireEvent.click(within(effortGroup).getByRole("radio", { name: "High" }));

    expect(onEffortChange).toHaveBeenCalledWith("high");
  });

  it("opens from the trigger with arrow keys and supports cmdk keyboard selection", async () => {
    const onValueChange = vi.fn();
    render(
      <ModelSelector
        models={models}
        value=""
        effort=""
        onValueChange={onValueChange}
        onEffortChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = await screen.findByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "GPT-5.5" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("pi:openai-codex:gpt-5.5");
  });

  it("disables the trigger while a turn is running", () => {
    render(
      <ModelSelector
        models={models}
        value=""
        effort=""
        onValueChange={vi.fn()}
        onEffortChange={vi.fn()}
        disabled
      />,
    );

    expect(
      screen.getByRole("button", { name: "Model and reasoning effort" }),
    ).toBeDisabled();
  });

  it("supports externally controlled open state", async () => {
    render(<ExternallyOpenedSelector />);

    expect(screen.queryByRole("dialog", { name: "Model and reasoning effort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open run settings" }));
    const popup = await screen.findByRole("dialog", {
      name: "Model and reasoning effort",
    });
    expect(popup).toBeVisible();

    fireEvent.keyDown(popup, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Model and reasoning effort" }),
      ).toBeNull();
    });
  });
});

describe("ModelSelector provider grouping", () => {
  const providerModels: readonly ModelSelectorOption[] = [
    { id: "", name: "Default model", description: "Use the agent default", efforts },
    {
      id: "provider:codex",
      name: "Codex θ",
      provider: "codex",
      providerLabel: "Codex",
      efforts,
    },
    {
      id: "provider:codex:old",
      name: "Codex θ older",
      provider: "codex",
      providerLabel: "Codex",
      efforts: efforts.slice(0, 2),
    },
    {
      id: "provider:anthropic:opus",
      name: "Opus 5",
      provider: "anthropic",
      providerLabel: "Anthropic",
      efforts: efforts.slice(0, 2),
    },
  ];

  const renderSelector = (overrides: Partial<Parameters<typeof ModelSelector>[0]> = {}) =>
    render(
      <ModelSelector
        models={providerModels}
        value=""
        effort=""
        onValueChange={vi.fn()}
        onEffortChange={vi.fn()}
        {...overrides}
      />,
    );

  it("renders provider headings and a chip row only when more than one provider is present", async () => {
    renderSelector();
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const popup = await screen.findByRole("dialog", { name: "Model and reasoning effort" });

    expect(
      within(popup).getByText("Codex", { selector: "[cmdk-group-heading]" }),
    ).toBeVisible();
    expect(
      within(popup).getByText("Anthropic", { selector: "[cmdk-group-heading]" }),
    ).toBeVisible();

    const providers = within(popup).getByRole("radiogroup", { name: "Filter by provider" });
    expect(within(providers).getAllByRole("radio")).toHaveLength(3);
    expect(within(providers).getByRole("radio", { name: "All" })).toBeChecked();
  });

  it("filters the list per provider while the automatic row stays reachable", async () => {
    renderSelector();
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const popup = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const providers = within(popup).getByRole("radiogroup", { name: "Filter by provider" });

    fireEvent.click(within(providers).getByRole("radio", { name: "Anthropic" }));

    expect(within(popup).queryByRole("option", { name: /Codex θ/u })).toBeNull();
    expect(within(popup).getByRole("option", { name: /Opus 5/u })).toBeVisible();
    expect(within(popup).getByRole("option", { name: /Default model/u })).toBeVisible();
  });

  it("requests a provider page when its chip is tapped", async () => {
    const onProviderRequest = vi.fn();
    renderSelector({ onProviderRequest });
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const popup = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    const providers = within(popup).getByRole("radiogroup", { name: "Filter by provider" });

    fireEvent.click(within(providers).getByRole("radio", { name: "Anthropic" }));

    expect(onProviderRequest).toHaveBeenCalledWith("anthropic");
  });

  it("shows an empty state when no models are offered", async () => {
    renderSelector({ models: [] });
    fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
    const popup = await screen.findByRole("dialog", { name: "Model and reasoning effort" });
    expect(within(popup).getByText("No models found.")).toBeVisible();
  });
});
