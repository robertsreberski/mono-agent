import type { Meta, StoryObj } from "@storybook/react-vite";
import { PdfExportNotice } from "../../components/PdfExport";

export default { title: "Chat & Messages/PDF Export Notice", component: PdfExportNotice,
  tags: ["autodocs"], args: { onDismiss: () => undefined }, parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PdfExportNotice>;
type Story = StoryObj<typeof PdfExportNotice>;
export const Generating: Story = { args: { state: { kind: "pending" } } };
export const Failed: Story = { args: { state: { kind: "error", message: "PDF export unavailable. Try again." } } };
export const Ready: Story = { args: { state: { kind: "ready", url: "#fictional-pdf", filename: "garden.pdf" } } };
