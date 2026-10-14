import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, expect, it } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import { AssistantMessage, UserMessage } from "./Messages";
import "../styles.css";

const warning = "Switched models without the previous model's full working context. The new model has the available conversation history, but not the earlier model's internal session state, so it may need key details repeated.";
const common = { threadId: "fictional-garden", status: "complete" as const, attachments: [],
  createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:01Z" };
const messages: WebMessage[] = [
  { ...common, id: "fictional-user", role: "user", parts: [{ type: "text", text: "Use fictional Grove for the garden plan." }] },
  { ...common, id: "fictional-answer", role: "assistant", parts: [
    { type: "telemetry", event: "runtime_warning", data: { type: "runtime_warning", warningKind: "degraded_native_context", message: warning } },
    { type: "telemetry", event: "runtime_warning", data: { warningKind: "provider", message: "Fictional private diagnostic remains hidden." } },
    { type: "text", text: "The fictional garden plan is ready." },
  ] },
];
function FictionalConversation() {
  const runtime = useExternalStoreRuntime<WebMessage>({ messages, convertMessage: (message) => convertWebMessage(message), onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport">
      <div className="message-column"><ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} /></div>
    </ThreadPrimitive.Viewport></ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
afterEach(async () => { await page.viewport(1440, 1000); });
it.each([[1280, 800, "desktop"], [390, 844, "mobile"]] as const)("renders the cold-context note in fictional Web activity at %ipx", async (width, height, label) => {
  await page.viewport(width, height); render(<FictionalConversation />);
  fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
  expect(await screen.findByText(warning)).toBeVisible();
  expect(screen.getByText("The fictional garden plan is ready.")).toBeVisible();
  expect(screen.queryByText("Fictional private diagnostic remains hidden.")).not.toBeInTheDocument();
  const note = screen.getByText(warning); expect(note).toHaveClass("activity-note");
  const box = note.getBoundingClientRect(); expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
  const shots = import.meta.env.VITE_DEGRADED_CONTEXT_SHOTS as string | undefined;
  if (shots) await page.screenshot({ path: `${shots}/degraded-native-context-${label}.png` });
});
