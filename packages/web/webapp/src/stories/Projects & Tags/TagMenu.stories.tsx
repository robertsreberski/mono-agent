import type { Meta, StoryObj } from "@storybook/react-vite";
import { TagMenu } from "../../components/tag/TagMenu";
import { gardenThread } from "../fixtures";
export default { title: "Projects & Tags/TagMenu", component: TagMenu, tags: ["autodocs"] } satisfies Meta<typeof TagMenu>;
type Story = StoryObj<typeof TagMenu>;
export const Thread: Story = { args: { thread: gardenThread } };
