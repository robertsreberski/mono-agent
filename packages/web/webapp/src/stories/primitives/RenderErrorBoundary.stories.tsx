import type { Meta, StoryObj } from "@storybook/react-vite";
import { RenderErrorBoundary, ConversationErrorFallback, RootErrorFallback } from "../../components/RenderErrorBoundary";
export default { title: "Primitives/RenderErrorBoundary", component: RenderErrorBoundary, tags: ["autodocs"] } satisfies Meta<typeof RenderErrorBoundary>;
type Story = StoryObj<typeof RenderErrorBoundary>;
export const Healthy: Story = { args: { children: <p>Garden planner is ready.</p>, fallback: ConversationErrorFallback, scope: "example", reporter: () => {} } };
export const ConversationFailure: Story = { args: { ...Healthy.args!, children: <ConversationErrorFallback error={new Error("Example render failure")} reset={() => {}} /> } };
export const FatalFallback: Story = { args: { ...Healthy.args!, children: <RootErrorFallback reload={() => {}} /> } };
