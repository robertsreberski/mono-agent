import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { CronChannelHeader } from "../../components/CronChannelHeader";
import { gardenThread, atlas } from "../fixtures";
import { storyStore } from "../store";
import { waitForOverlay } from "../overlay-play";

const job = { jobId: "garden-daily", expression: "0 9 * * *", timezone: "UTC", conversationId: "cron:garden-daily", configured: true, declaredEnabled: true, effectiveEnabled: true, health: "healthy" as const, threadId: "garden-cron" };
function CronPreview({ active }: { readonly active: boolean }) {
  const previous = { selectedThread: storyStore.selectedThread, selectedAgent: storyStore.selectedAgent, cronOverview: storyStore.cronOverview };
  Object.assign(storyStore, {
    selectedThread: { ...gardenThread, id: "garden-cron", trigger: { kind: "cron", jobId: job.jobId, configured: true } },
    selectedAgent: { ...atlas, cron: { read: true, actions: true } },
    cronOverview: { generatedAt: "2026-01-15T10:00:00Z", actionsEnabled: active, jobs: [{ ...job, effectiveEnabled: active }] },
  });
  useEffect(() => () => { Object.assign(storyStore, previous); }, []);
  return <CronChannelHeader />;
}
export default { title: "Chat & Messages/CronChannelHeader", component: CronChannelHeader, tags: ["autodocs"] } satisfies Meta<typeof CronChannelHeader>;
type Story = StoryObj<typeof CronChannelHeader>;
export const Active: Story = { render: () => <CronPreview active /> };
export const Paused: Story = { render: () => <CronPreview active={false} /> };
export const Mobile: Story = { render: () => <CronPreview active />, globals: { viewport: { value: "phone" } } };
export const ConfirmationOpen: Story = { render: () => <CronPreview active />, play: async ({ canvasElement }) => {
  const disclosure = canvasElement.querySelector<HTMLElement>('.cron-channel-overview summary');
  if (!disclosure) throw new Error("Cron disclosure missing");
  disclosure.click();
  const button = [...canvasElement.querySelectorAll<HTMLButtonElement>('.cron-channel-overview button')].find((element) => element.textContent?.includes("Run now"));
  if (!button) throw new Error("Run now control missing");
  button.click();
  await waitForOverlay(canvasElement, '[role="dialog"][aria-label="Confirm cron action"]');
} };
export const ConfigOpen: Story = { render: () => <CronPreview active />, play: async ({ canvasElement }) => {
  const disclosure = canvasElement.querySelector<HTMLElement>('.cron-channel-overview summary');
  if (!disclosure) throw new Error("Cron disclosure missing");
  disclosure.click();
  const button = canvasElement.querySelector<HTMLButtonElement>('.cron-channel-overview button:nth-of-type(3)');
  if (!button) throw new Error("View config control missing");
  button.click();
  await waitForOverlay(canvasElement, '[role="dialog"][aria-label="Cron configuration"]');
} };
