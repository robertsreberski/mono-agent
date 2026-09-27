import type { Meta, StoryObj } from "@storybook/react-vite";
import { McpAppPart } from "../../components/ReplyParts";
import type { MessagePart } from "../../types";
const app = { type: "mcp_app", id: "garden-app", invocationId: "11111111-1111-4111-8111-111111111111", connectionId: "example-connection", serverName: "garden-tools", toolName: "render_plan", resourceUri: "ui://garden-tools/plan", mediaType: "text/html;profile=mcp-app", protocolVersion: "2026-01-26", title: "Garden planner" } satisfies Extract<MessagePart, { type: "mcp_app" }>;
export default { title: "Chat & Messages/McpAppPart", component: McpAppPart, tags: ["autodocs"] } satisfies Meta<typeof McpAppPart>;
type Story = StoryObj<typeof McpAppPart>;
// No host URL or bridge: demonstrate the real unavailable/retained placeholder
// without creating a live iframe, capability token or network request.
export const UnavailablePlaceholder: Story = { args: { data: app } as Parameters<typeof McpAppPart>[0] };
export const LongTitle: Story = { args: { data: { ...app, title: "Garden planning canvas with several planting zones and monthly tasks" } } as Parameters<typeof McpAppPart>[0] };
