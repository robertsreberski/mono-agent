import { AssistantRuntimeProvider, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { ReactNode } from "react";

/** A local, transport-free assistant-ui runtime for visual examples. */
export const sampleMessages = [
  { role: "user" as const, content: "Morgan: Can you help outline a garden planner?" },
  { role: "assistant" as const, content: "# Garden planner\n\nHere is a small plan for a **fictional** garden.\n\n- Map three beds\n- Choose low-water plants\n- Check seedlings weekly\n\n| Bed | Plant |\n| --- | --- |\n| North | Sage |\n| South | Thyme |\n\n```ts\nconst beds = [\"north\", \"south\"];\n```" },
  { role: "system" as const, content: "Example project context: Garden planner" },
];
export function StoryRuntime({ children, messages = sampleMessages }: { readonly children: ReactNode; readonly messages?: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [{ type: "text", text: "The example garden plan is ready." }] }) }, { initialMessages: messages });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
