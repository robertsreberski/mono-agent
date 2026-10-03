import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderUsageMeters } from "../../components/ProviderUsageMeters";
import type { ProviderUsage } from "../../types";
const periodMs = 7 * 24 * 60 * 60 * 1000;
const fetchedAt = new Date(Date.now() - periodMs / 4).toISOString();
const resetsAt = new Date(Date.parse(fetchedAt) + periodMs).toISOString();
const base: ProviderUsage = { providerId: "anthropic", label: "Example provider", fetchedAt, stale: false, windows: [
  { kind: "session", label: "Session", usedPercent: 12, periodMs, resetsAt },
  { kind: "weekly", label: "Weekly", usedPercent: 51, periodMs, resetsAt },
  { kind: "monthly", label: "Monthly", usedPercent: 97, periodMs, resetsAt },
] };
export default { title: "Primitives/ProviderUsageMeters", component: ProviderUsageMeters, tags: ["autodocs"] } satisfies Meta<typeof ProviderUsageMeters>;
type Story = StoryObj<typeof ProviderUsageMeters>;
export const SeveralWindows: Story = { args: { usage: base } };
export const Steady: Story = { args: { usage: { ...base, windows: [base.windows[0]!] } } };
export const Ahead: Story = { args: { usage: { ...base, windows: [base.windows[1]!] } } };
export const Unsustainable: Story = { args: { usage: { ...base, windows: [base.windows[2]!] } } };
export const Stale: Story = { args: { usage: { ...base, stale: true, error: { code: "unavailable", message: "Example usage temporarily unavailable" } } } };
export const Empty: Story = { args: {} };
