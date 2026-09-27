import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { AgentSettingsDialog } from "../../components/AgentSettingsDialog";
import { atlas } from "../fixtures";
import { storyStore } from "../store";

const dialogRef = { current: null };
function AuthAgentPreview({ children, state }: { readonly children: React.ReactNode; readonly state?: "missing" | "verified" }) {
  if (state) Object.assign(storyStore, {
    selectedAgent: { ...atlas, sourceId: `atlas-story-auth-${state}`, supportsProviderAuth: true,
      providers: [{ id: "atlas", label: "Atlas Cloud", configured: true }] },
    selectedAgentId: `atlas-story-auth-${state}`,
  });
  useEffect(() => () => { if (state) Object.assign(storyStore, { selectedAgent: atlas, selectedAgentId: atlas.sourceId }); }, [state]);
  return <>{children}</>;
}
export default {
  title: "Dialogs & Settings/AgentSettingsDialog", component: AgentSettingsDialog, tags: ["autodocs"],
  decorators: [(Story, context) => <AuthAgentPreview state={context.parameters.authVariant}><Story /></AuthAgentPreview>],
} satisfies Meta<typeof AgentSettingsDialog>;
type Story = StoryObj<typeof AgentSettingsDialog>;
export const Open: Story = { args: { open: true, onClose: () => {}, dialogRef } };
export const MissingAuth: Story = { args: { ...Open.args! }, parameters: { authVariant: "missing" } };
export const VerifiedAuth: Story = { args: { ...Open.args! }, parameters: { authVariant: "verified" } };
export const Closed: Story = { args: { ...Open.args!, open: false } };
export const Mobile: Story = { args: { ...Open.args! }, globals: { viewport: { value: "phone" } } };
