import type { Meta, StoryObj } from "@storybook/react-vite";
import { RouteBadge } from "../../components/RouteBadge";

export default { title: "Primitives/RouteBadge", component: RouteBadge, tags: ["autodocs"] } satisfies Meta<typeof RouteBadge>;
type Story = StoryObj<typeof RouteBadge>;
export const Selected: Story = { args: { modelShort: "Atlas", effortShort: "Medium", label: "Atlas standard, medium effort", title: "Atlas standard, medium effort" } };
export const Fallback: Story = { args: { ...Selected.args!, modelShort: "Grove", fallback: true, label: "Fallback to Grove", title: "Fallback to Grove" } };
export const Requested: Story = { args: { ...Selected.args!, requestedOnly: true } };
export const Compact: Story = { args: { ...Selected.args!, compact: true } };
