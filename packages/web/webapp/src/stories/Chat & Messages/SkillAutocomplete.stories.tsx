import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { SkillAutocomplete } from "../../components/assistant-ui/SkillPicker";
import type { SkillInfo } from "../../types";
const skills: SkillInfo[] = [
  { name: "garden-planning", description: "Sketch a fictional garden plan", reference: "$garden-planning", availability: "on-demand" },
  { name: "garden-notes", description: "Summarize a garden notebook", reference: "$garden-notes", availability: "inlined" },
];
function Suggestions({ query = "garden" }: { readonly query?: string }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "Example only" }] }) });
  useEffect(() => {
    runtime.thread.composer.setText(`${query}`);
    const timer = setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Example skill prompt"]')?.focus(), 40);
    return () => clearTimeout(timer);
  }, [runtime, query]);
  return <AssistantRuntimeProvider runtime={runtime}><ComposerPrimitive.Unstable_TriggerPopoverRoot><ComposerPrimitive.Root><ComposerPrimitive.Input aria-label="Example skill prompt" /><SkillAutocomplete skills={skills} query={query} cursor={0} onSelect={() => {}} /></ComposerPrimitive.Root></ComposerPrimitive.Unstable_TriggerPopoverRoot></AssistantRuntimeProvider>;
}
export default { title: "Chat & Messages/SkillAutocomplete", component: SkillAutocomplete, tags: ["autodocs"] } satisfies Meta<typeof SkillAutocomplete>;
type Story = StoryObj<typeof SkillAutocomplete>;
const typeSuggestion: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const field = canvasElement.querySelector<HTMLTextAreaElement>('textarea[aria-label="Example skill prompt"]');
  if (!field) return;
  field.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(field, "$garden");
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "$garden" }));
};
export const SuggestionsOpen: Story = { render: () => <Suggestions />, play: typeSuggestion };
export const Filtered: Story = { render: () => <Suggestions query="notes" />, play: typeSuggestion };
export const Mobile: Story = { render: () => <Suggestions />, play: typeSuggestion, globals: { viewport: { value: "phone" } } };
