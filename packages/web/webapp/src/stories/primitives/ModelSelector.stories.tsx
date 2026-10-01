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
