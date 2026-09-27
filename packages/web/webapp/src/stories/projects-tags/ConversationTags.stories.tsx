import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConversationTags } from "../../components/tag/ConversationTags";

export default { title: "Projects & Tags/ConversationTags", component: ConversationTags, tags: ["autodocs"] } satisfies Meta<typeof ConversationTags>;
type Story = StoryObj<typeof ConversationTags>;
export const ResearchTag: Story = {};
export const Mobile: Story = { globals: { viewport: { value: "phone" } } };
