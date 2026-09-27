import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { ComposerTriggerPopover, type ComposerTriggerCommand } from "../../components/assistant-ui/ComposerTriggerPopover";
import { waitForOverlay } from "../overlay-play";
const commands: ComposerTriggerCommand[] = [
  { id: "new", label: "New conversation", description: "Start a fictional garden topic", icon: "new", execute: () => {} },
  { id: "stop", label: "Stop response", description: "End the current example", icon: "stop", execute: () => {} },
];
function Popover({ value = "/" }: { readonly value?: string }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "Example only" }] }) });
  useEffect(() => {
    runtime.thread.composer.setText(value);
    const timer = setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Example command prompt"]')?.focus(), 40);
    return () => clearTimeout(timer);
  }, [runtime, value]);
  return <AssistantRuntimeProvider runtime={runtime}><ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root><ComposerPrimitive.Input aria-label="Example command prompt" /><ComposerTriggerPopover commands={commands} /></ComposerPrimitive.Root></ComposerPrimitive.Unstable_TriggerPopoverRoot></AssistantRuntimeProvider>;
}
export default { title: "Chat & Messages/ComposerTriggerPopover", component: ComposerTriggerPopover, tags: ["autodocs"] } satisfies Meta<typeof ComposerTriggerPopover>;
type Story = StoryObj<typeof ComposerTriggerPopover>;
const typeCommand: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const field = canvasElement.querySelector<HTMLTextAreaElement>('textarea[aria-label="Example command prompt"]');
  if (!field) return;
  field.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(field, "/n");
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/n" }));
  await waitForOverlay(canvasElement, '[data-slot="composer-trigger-list"]');
};
export const CommandsOpen: Story = { render: () => <Popover />, play: typeCommand };
export const Filtered: Story = { render: () => <Popover value="/new" />, play: typeCommand };
export const Mobile: Story = { render: () => <Popover />, play: typeCommand, globals: { viewport: { value: "phone" } } };
