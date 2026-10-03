import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent } from "storybook/test";
import { useEffect, useRef, useState } from "react";
import { TagMenu } from "../../components/tag/TagMenu";
import { TagSettingsSheet, type TagSettingsState } from "../../components/tag/TagSettingsSheet";
import { gardenThread } from "../fixtures";
import { waitForOverlay } from "../overlay-play";

function MenuAndSheet() {
  const [sheet, setSheet] = useState<TagSettingsState | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const open = (event: Event) => setSheet((event as CustomEvent<TagSettingsState>).detail);
    window.addEventListener("mono-agent:tag-settings", open);
    return () => window.removeEventListener("mono-agent:tag-settings", open);
  }, []);
  return <><TagMenu thread={gardenThread} /><TagSettingsSheet sheet={sheet} onClose={() => setSheet(null)} dialogRef={dialogRef} /></>;
}
const open: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const button = canvasElement.querySelector<HTMLElement>('[aria-label="Conversation tags"]');
  if (!button) throw new Error("Tag menu trigger missing");
  await userEvent.click(button);
  await waitForOverlay(canvasElement, '.tag-menu-popup');
  await waitForOverlay(canvasElement, '[aria-label="Remove Research"]');
};
export default { title: "Projects & Tags/TagMenu", component: TagMenu, tags: ["autodocs"] } satisfies Meta<typeof TagMenu>;
type Story = StoryObj<typeof TagMenu>;
export const Closed: Story = { args: { thread: gardenThread } };
export const Open: Story = { args: Closed.args, play: open };
export const EditTagsOpen: Story = { args: Closed.args, play: async (context) => {
  await open(context);
  const edit = [...context.canvasElement.ownerDocument.querySelectorAll<HTMLElement>('.tag-menu-popup .conversation-menu-item')].find((element) => element.textContent?.includes("Edit tags"));
  if (!edit) throw new Error("Edit tags submenu trigger missing");
  await userEvent.click(edit);
  await waitForOverlay(context.canvasElement, '.tag-menu-popup[aria-label="Edit tags"]');
} };
export const CreateTag: Story = { render: () => <MenuAndSheet />, play: async (context) => {
  await open(context);
  const create = [...context.canvasElement.ownerDocument.querySelectorAll<HTMLElement>('.tag-menu-popup .conversation-menu-item')].find((element) => element.textContent?.includes("New tag"));
  if (!create) throw new Error("New tag action missing");
  await userEvent.click(create);
  await waitForOverlay(context.canvasElement, '.tag-settings-sheet[role="dialog"]');
} };
