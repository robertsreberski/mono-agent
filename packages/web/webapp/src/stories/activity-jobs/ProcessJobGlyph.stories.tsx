import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProcessJobGlyph, ProcessJobSpinner } from "../../components/ProcessJobGlyph";
import { processJobDisplayState } from "../../components/process-job-display";
import * as J from "../job-fixtures";

// Every status the shelf can show, derived from real fictional projections by
// the same rules the rows use, so the gallery cannot drift from the product.
const NOW = Date.now();
const CURRENT: readonly J.Job[] = [J.queued, J.starting, J.runningTail, J.stopping, J.peerPending];
const SETTLED: readonly J.Job[] = [J.succeeded, J.failed, J.spawnFailed, J.interrupted, J.timedOut, J.queueExpired, J.cancelled];

function Column({ title, jobs }: { readonly title: string; readonly jobs: readonly J.Job[] }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "20px 16px auto", alignItems: "center", alignContent: "start", columnGap: 12, rowGap: 11 }}>
      <h3 style={{ gridColumn: "1 / -1", margin: "0 0 2px", color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>{title}</h3>
      {jobs.map((job) => {
        const state = processJobDisplayState(job, NOW);
        return [
          <ProcessJobGlyph key={`${job.jobId}-row`} tone={state.tone} mark={state.mark} />,
          <ProcessJobGlyph key={`${job.jobId}-bar`} small tone={state.tone} mark={state.mark} />,
          <span key={`${job.jobId}-word`} className="process-job-card" data-tone={state.tone} style={{ fontSize: 12.5 }}>
            <span className="process-job-state">{state.word}</span>
          </span>,
        ];
      })}
    </section>
  );
}

/** The status glyph family at row (20 px) and bar (16 px) size, with each state's word. */
function StatusGallery() {
  return (
    <div className="process-job-stack is-open" style={{ width: 460, maxHeight: "none", padding: "14px 16px 16px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Column title="Current (outlined)" jobs={CURRENT} />
        <Column title="Settled (solid)" jobs={SETTLED} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)", color: "var(--text-muted)", fontSize: 11.5 }}>
        <span className="process-job-chip is-running"><span className="process-job-chip-mark"><ProcessJobSpinner /></span><span className="process-job-chip-count">3</span></span>
        <ProcessJobSpinner />
        <span>The closed bar's spinner: the only mark that moves. Rows hold the half-filled ring.</span>
      </div>
    </div>
  );
}

export default {
  title: "Activity & Jobs/ProcessJobGlyph",
  component: StatusGallery,
  parameters: { docs: { description: { component: "Every background-job status glyph. Outlined rings are current work, solid discs settled outcomes; in progress is yellow and done is green in every console theme." } } },
} satisfies Meta<typeof StatusGallery>;
type Story = StoryObj<typeof StatusGallery>;

export const Gallery: Story = {};
export const GalleryDark: Story = { globals: { scheme: "dark" } };
// Status colours never follow the accent: the same yellow and green in every palette.
export const GalleryTerracotta: Story = { globals: { theme: "terracotta" } };
export const GalleryTerracottaDark: Story = { globals: { scheme: "dark", theme: "terracotta" } };
export const GalleryPlumDark: Story = { globals: { scheme: "dark", theme: "plum" } };
export const GalleryOcean: Story = { globals: { theme: "ocean" } };
