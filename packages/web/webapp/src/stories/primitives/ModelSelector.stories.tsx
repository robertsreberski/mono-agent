import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelSelector } from "../../components/assistant-ui/ModelSelector";
export default { title: "Primitives/ModelSelector", component: ModelSelector, tags: ["autodocs"] } satisfies Meta<typeof ModelSelector>;
type Story = StoryObj<typeof ModelSelector>;
const models = [{ id: "atlas/standard", name: "Atlas Standard", provider: "atlas", providerLabel: "Atlas", efforts: [{ id: "low", name: "Low" }, { id: "medium", name: "Medium" }] }, { id: "grove/fast", name: "Grove Fast", provider: "grove", providerLabel: "Grove", efforts: [] }];
export const Selected: Story = { args: { models, value: "atlas/standard", effort: "medium", onValueChange: () => {}, onEffortChange: () => {} } };
export const Open: Story = { args: { ...Selected.args!, open: true, onOpenChange: () => {} } };
export const Disabled: Story = { args: { ...Selected.args!, disabled: true } };
