import { cleanup, render, screen } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processJob } from "../test/fixtures";
import type { ProcessJobProjection } from "../types";
import "../styles.css";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  api: { threadJob: vi.fn() },
}));

import { api } from "../api";
import { ProcessJobPart } from "./ProcessJob";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
  }
}

/**
 * Screenshot evidence is opt-in, like the empty-output and route-badge suites:
 * `VITE_PEER_QUESTION_SHOTS=<absolute dir>` writes the card shots and CI runs
 * the same DOM assertions without writing anything.
 */
const shotDirectory = import.meta.env.VITE_PEER_QUESTION_SHOTS as string | undefined;

const capture = async (name: string, element: Element): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.elementLocator(element).screenshot({ path: `${shotDirectory}/${name}.png` });
};

type ProcessJobProps = Parameters<typeof ProcessJobPart>[0];
type PeerQuestion = NonNullable<Extract<ProcessJobProjection, { kind: "internal" }>["peerQuestion"]>;

/** The dock's own chrome, so a card is measured in the box it actually sits in. */
const dock = (job: ProcessJobProjection) => (
  <section className="process-job-stack">
    <div className="process-job-stack-header">
      <div className="process-job-stack-heading">
        <span className="process-job-stack-title">Background jobs</span>
        <span className="process-job-stack-counts">1 job · 0 active · 1 history</span>
      </div>
    </div>
    <div className="process-job-stack-body">
      <div className="process-job-stack-list">
        <div className="process-job-stack-item">
          <ProcessJobPart {...({ data: { job } } as unknown as ProcessJobProps)} />
        </div>
      </div>
    </div>
  </section>
);

/**
 * Synthetic fixtures, not a recorded session: the peer, thread, wording and
 * choices are hand-written, shaped like the ACP bridge's AskUser form (one
 * choice field plus its paired "Other" free-text field).
 */
const expiresAt = new Date(Date.now() + 24 * 60 * 1_000).toISOString();
const englishForm = {
  type: "object",
  required: ["question_1"],
  properties: {
    question_1: {
      type: "string", title: "Rebalance", description: "Move 20% of the portfolio into short-dated treasuries?",
      oneOf: [
        { const: "approve", title: "Approve", description: "Place the order today." },
        { const: "hold", title: "Hold until Monday" },
        { const: "__mono_agent_custom__", title: "Other", description: "Provide a custom response in “question_1_other”." },
      ],
    },
    question_1_other: {
      type: "string", title: "Rebalance — Other response",
      description: "Complete only when “Other” is selected for “question_1”.",
    },
  },
};
const polishForm = {
  type: "object",
  required: ["question_1"],
  properties: {
    question_1: {
      type: "string", title: "Decyzja", description: "Czy przenieść środki przed końcem kwartału?",
      oneOf: [
        { const: "tak", title: "Tak, przenieś" },
        { const: "nie", title: "Nie, wstrzymaj" },
        { const: "__mono_agent_custom__", title: "Inna odpowiedź" },
      ],
    },
    question_1_other: { type: "string", title: "Decyzja — własna odpowiedź" },
  },
};

const question = (overrides: Partial<PeerQuestion> = {}): PeerQuestion => ({
  state: "awaiting_answer",
  questionId: "8f3c2a1e-5b7d-4c9a-9e21-6d4f0b3a7c55",
  peer: "finance",
  thread: "portfolio",
  message: "Before I rebalance, I need a decision from you.\nThe quarterly report closes on Friday; should I move 20% into short-dated treasuries now?",
  requestedSchema: englishForm,
  expiresAt,
  ...overrides,
});

const peerJob = (peerQuestion: PeerQuestion): ProcessJobProjection => processJob({
  tool: "PeerAgent",
  kind: "internal",
  instanceId: "finance",
  childStillBusy: false,
  summary: "Peer finance thread portfolio",
  peerQuestion,
});

const fixtures = [
  { name: "awaiting", job: peerJob(question()), state: "Waiting for the agent's answer", chip: "Hold until Monday" },
  { name: "polish", job: peerJob(question({ requestedSchema: polishForm,
    message: "Czy mogę przenieść 20% portfela do krótkoterminowych obligacji skarbowych przed końcem kwartału? Potrzebuję Twojej decyzji, zanim złożę zlecenie." })),
  state: "Waiting for the agent's answer", chip: "Nie, wstrzymaj" },
  { name: "answered", job: peerJob(question({ state: "answered" })), state: "Answered", chip: "Approve" },
  { name: "expired", job: peerJob(question({ state: "expired" })), state: "Expired", chip: "Approve" },
] as const;

beforeEach(async () => {
  vi.mocked(api.threadJob).mockImplementation(() => new Promise(() => undefined));
  await commands.emulateColorScheme("light");
  await page.viewport(1_280, 900);
});

afterEach(async () => {
  cleanup();
  await commands.emulateColorScheme(null);
  vi.restoreAllMocks();
});

describe("a PeerAgent question card", () => {
  it.each([
    { viewport: "desktop", width: 1_280, height: 900 },
    { viewport: "mobile", width: 390, height: 844 },
  ])("renders readable fields that fit the $viewport dock", async ({ viewport, width, height }) => {
    await page.viewport(width, height);
    for (const fixture of fixtures) {
      const view = render(dock(fixture.job));
      screen.getByRole("group", { name: "PeerAgent background job succeeded" }).setAttribute("open", "");
      const region = screen.getByRole("region", { name: "Peer question" });
      await expect.element(page.getByText(fixture.state)).toBeVisible();
      await expect.element(page.getByText(fixture.chip, { exact: true })).toBeVisible();
      expect(region.querySelector(".peer-question-schema")?.hasAttribute("open")).toBe(false);
      expect(region).toHaveTextContent("Untrusted peer text; not owner approval.");
      expect(region).not.toHaveTextContent("awaiting_answer");
      const stack = view.container.querySelector(".process-job-stack")!;
      expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      expect(stack.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1);
      // The live dock body scrolls at min(38vh, 320px); unclamp it only for the
      // evidence shot so the whole card is visible in one image.
      const body = stack.querySelector<HTMLElement>(".process-job-stack-body");
      if (body && shotDirectory) body.style.maxHeight = "none";
      await capture(`peer-question-${fixture.name}-${viewport}`, stack);
      cleanup();
    }
  });
});
