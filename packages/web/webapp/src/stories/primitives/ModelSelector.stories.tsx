import { userEvent, within } from "storybook/test";
import { selectorModels } from "../../components/assistant-ui/ModelSelector.fixtures";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelSelector } from "../../components/assistant-ui/ModelSelector";
import { waitForOverlay } from "../overlay-play";
export default { title: "Primitives/ModelSelector", component: ModelSelector, tags: ["autodocs"] } satisfies Meta<typeof ModelSelector>;
type Story = StoryObj<typeof ModelSelector>;
const models = [{ id: "atlas/standard", name: "Atlas Standard", provider: "atlas", providerLabel: "Atlas", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }] }, { id: "grove/fast", name: "Grove Fast", provider: "grove", providerLabel: "Grove", efforts: [] }];
export const Selected: Story = { args: { models, value: "atlas/standard", effort: "medium", onValueChange: () => {}, onEffortChange: () => {} } };
export const Open: Story = { args: { ...Selected.args!, open: true, onOpenChange: () => {} }, play: async ({ canvasElement }) => { await waitForOverlay(canvasElement, '[data-slot="model-selector-content"]'); } };
export const Disabled: Story = { args: { ...Selected.args!, disabled: true } };

export const Context1M: Story = { args: { ...Selected.args!, models: [{ id: "synthetic:gpt", name: "Synthetic eligible GPT", efforts: models[0]!.efforts, standardContextWindow: 272_000, supportsContext1M: true }], value: "synthetic:gpt", context1M: true, onContext1MChange: () => {}, open: true }, play: Open.play };

export const ContextStandard: Story = { ...Context1M, args: { ...Context1M.args!, context1M: false } };
export const ContextWithoutEffort: Story = { ...Context1M, args: { ...Context1M.args!, models: [{ ...Context1M.args!.models![0]!, efforts: [] }] } };
export const ContextIneligible: Story = { ...Context1M, args: { ...Context1M.args!, models: [{ id: "synthetic:standard", name: "Synthetic ineligible model", efforts: models[0]!.efforts }], value: "synthetic:standard", context1M: false } };


/** Seven providers, 28 models, full effort ladder and all optional controls. */
export const DenseCatalog: Story = {
  args: { models: selectorModels, value: "", effort: "medium", context1M: true,
    onValueChange: () => {}, onEffortChange: () => {}, onContext1MChange: () => {},
    onReset: () => {}, agentDefaultId: "atlas:standard", showModelChangeHint: true, open: true, side: "top" },
  decorators: [(Story) => <div className="composer-actions" style={{ position: "fixed", bottom: 20, left: 16, right: 16 }}><Story /></div>],
  play: Open.play,
};
export const SettingsTrigger: Story = {
  ...DenseCatalog, args: { ...DenseCatalog.args!, side: "bottom" },
  decorators: [(Story) => <div className="settings-screen" style={{ padding: 24, maxWidth: 540 }}><Story /></div>],
};
export const EmptySearch: Story = { ...DenseCatalog, play: async ({ canvasElement }) => {
  await waitForOverlay(canvasElement, '[data-slot="model-selector-content"]');
  await userEvent.type(within(canvasElement.ownerDocument.body).getByRole("combobox", { name: "Search models" }), "no-such-model");
} };
export const LoadingProvider: Story = {
  ...DenseCatalog,
  args: { ...DenseCatalog.args!, models: [], value: "", effort: "", agentProviders: [
    { id: "atlas", label: "Atlas" }, { id: "grove", label: "Grove" },
  ], providerStatus: { grove: "loading" }, onProviderRequest: () => {} },
  play: async ({ canvasElement }) => {
    await waitForOverlay(canvasElement, '[data-slot="model-selector-content"]');
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("radio", { name: "Grove" }));
  },
};
