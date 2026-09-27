import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReplyFailurePart } from "../../components/ReplyParts";
import type { MessagePart } from "../../types";
const failure = { type: "failure", id: "failure-1", code: "artifact_missing", message: "The example garden sketch is no longer available." } satisfies Extract<MessagePart, { type: "failure" }>;
const props = { data: failure } as Parameters<typeof ReplyFailurePart>[0];
export default { title: "Chat & Messages/ReplyFailurePart", component: ReplyFailurePart, tags: ["autodocs"] } satisfies Meta<typeof ReplyFailurePart>;
type Story = StoryObj<typeof ReplyFailurePart>;
export const MissingArtifact: Story = { args: props };
export const TooLarge: Story = { args: { data: { ...failure, code: "artifact_too_large", message: "Example garden sketch exceeds the allowed size." } } as Parameters<typeof ReplyFailurePart>[0] };
