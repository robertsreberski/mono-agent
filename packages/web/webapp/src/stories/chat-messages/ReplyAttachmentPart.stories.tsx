import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReplyAttachmentPart } from "../../components/ReplyParts";
import type { MessagePart } from "../../types";
const attachment = { type: "attachment", id: "outline", artifactId: "outline-artifact", name: "garden-outline.txt", mediaType: "text/plain", sizeBytes: 64, integrityId: "sha256:fictional-example" } satisfies Extract<MessagePart, { type: "attachment" }>;
export default { title: "Chat & Messages/ReplyAttachmentPart", component: ReplyAttachmentPart, tags: ["autodocs"] } satisfies Meta<typeof ReplyAttachmentPart>;
type Story = StoryObj<typeof ReplyAttachmentPart>;
export const Unavailable: Story = { args: { data: attachment } as Parameters<typeof ReplyAttachmentPart>[0] };
export const LongFilename: Story = { args: { data: { ...attachment, name: "garden-outline-with-extra-planning-notes-and-botanical-references.txt" } } as Parameters<typeof ReplyAttachmentPart>[0] };
export const Mobile: Story = { args: { data: attachment } as Parameters<typeof ReplyAttachmentPart>[0], globals: { viewport: { value: "phone" } } };
