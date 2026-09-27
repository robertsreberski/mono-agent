import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThreadPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { ComposerAttachments, UserMessageAttachments } from "../../components/Attachments";
import { MessageGallery } from "../../components/ImageGallery";
import { StoryRuntime } from "../runtime";
const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='140'%3E%3Crect width='240' height='140' fill='%2324725f'/%3E%3C/svg%3E";
const messages = [{ role: "user" as const, content: "Morgan's garden sketch", attachments: [
  { id: "drawing", type: "image", name: "garden-sketch.svg", contentType: "image/svg+xml", status: { type: "complete" as const }, content: [{ type: "image" as const, image }] },
  { id: "notes", type: "file", name: "garden-notes.txt", contentType: "text/plain", status: { type: "complete" as const }, content: [{ type: "file" as const, data: "data:text/plain,Garden%20notes", mimeType: "text/plain" }] },
] }];
function UserAttachments() { return <StoryRuntime messages={messages}><ThreadPrimitive.Root><ThreadPrimitive.Viewport><ThreadPrimitive.Messages components={{ UserMessage: () => <MessagePrimitive.Root><MessageGallery><UserMessageAttachments /></MessageGallery></MessagePrimitive.Root>, AssistantMessage: () => null }} /></ThreadPrimitive.Viewport></ThreadPrimitive.Root></StoryRuntime>; }
export default { title: "Chat & Messages/Attachments", component: UserMessageAttachments, tags: ["autodocs"] } satisfies Meta<typeof UserMessageAttachments>;
type Story = StoryObj<typeof UserMessageAttachments>;
export const SentImageAndFile: Story = { render: () => <UserAttachments /> };
export const ComposerEmpty: Story = { render: () => <StoryRuntime><ComposerAttachments /></StoryRuntime> };
export const Mobile: Story = { render: () => <UserAttachments />, globals: { viewport: { value: "phone" } } };
