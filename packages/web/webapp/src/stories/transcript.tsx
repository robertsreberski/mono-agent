import { ThreadPrimitive, type ThreadMessageLike } from "@assistant-ui/react";
import { AssistantMessage, UserMessage, SystemMessage } from "../components/Messages";
import { StoryRuntime, sampleMessages } from "./runtime";
export function Transcript({ messages = sampleMessages }: { readonly messages?: readonly ThreadMessageLike[] }) {
  return <StoryRuntime messages={messages}><ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport"><div className="message-column"><ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, SystemMessage }} /></div></ThreadPrimitive.Viewport></ThreadPrimitive.Root></StoryRuntime>;
}
