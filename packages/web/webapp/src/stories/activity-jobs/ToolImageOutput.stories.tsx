import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityPayload, ActivityRow } from "../../components/ActivityRow";
import { TOOL_IMAGE } from "../../test/tool-image-fixture";

function Example({ truncated = false }: { readonly truncated?: boolean }) {
  const [repaired, setRepaired] = useState(false);
  const whole = JSON.stringify(TOOL_IMAGE);
  const preview = truncated && !repaired;
  return <ActivityRow label="Read" summary="synthetic.png" open>
    <ActivityPayload args={{ file_path: "pictures/synthetic.png" }}
      result={preview ? whole.slice(0, 100) : whole} resultTruncated={preview} resultBytes={whole.length}
      onLoadFull={async () => { setRepaired(true); return true; }} />
  </ActivityRow>;
}
export default { title: "Activity & Jobs/ToolImageOutput", component: Example, tags: ["autodocs"] } satisfies Meta<typeof Example>;
type Story = StoryObj<typeof Example>;
export const Inline: Story = {};
export const LazyRepair: Story = { args: { truncated: true } };
export const Phone: Story = { globals: { viewport: { value: "phone" } } };
