import { expect, it } from "vitest";
import { replayLedgerSelection } from "../lib/continuity-selection-replay.mjs";

const letters = n => String.fromCharCode(65 + Math.floor(n / 26), 65 + n % 26);
const words = "garden meadow lantern orchard cedar willow ribbon marble pebble harbor ".repeat(80);
const names = ["read_notes", "read_inventory", "read_archive", "read_status", "read_catalog", "read_report"];
// Leave all owners uncited, including after an analysis-only second pass.
const citeTool = (pass, rows) => pass === 2 ? [] : [{ kind: "open_work", value: "Fictional register review.", status: "unknown", sources: [rows.find(row => row.kind === "tool").id] }];
const ownerOffers = (passes, text) => passes.filter(pass => pass.offered.some(row => row.owner && row.text === text)).map(pass => pass.pass);

it("offers a late cancellation main never fits, while preserving the long initial constraint and delta caps", async () => {
  const initial = "Never send anything without my approval. " + words.slice(0, 700);
  const cancellation = "Cancel my promise to prepare the garden report; do not prepare or send it until I confirm.";
  const records = [{ kind: "owner", text: initial }];
  for (let i = 0; i < 48; i++) {
    records.push({ kind: "owner", text: `Review the ${letters(i)} exhibit. ` + words.slice(0, 550) });
    for (const toolName of names) records.push({ kind: "tool", toolName, text: `Fictional exhibit ${letters(i)} register.\n\n${words}` });
  }
  records.push({ kind: "owner", text: cancellation });
  const passes = await replayLedgerSelection(records, { entriesForPass: citeTool });
  expect(passes.map(p => p.deltaCap)).toEqual([8, 8, 8]);
  expect(passes.map(p => p.published)).toEqual([true, false, true]);
  expect(ownerOffers(passes, initial)).toContain(1);
  expect(ownerOffers(passes, cancellation)).toContain(2);
  const source = passes[1].records.find(r => r.text === cancellation);
  expect(source.inputId).toBe("fictional-input-337");
  expect(passes[1].offered).toContainEqual(expect.objectContaining({ recordId: source.recordId, owner: true, text: cancellation }));
}, 60000);

it("retains the next-action second offer after an uncited first offer and empty delta, but never makes a third offer", async () => {
  const constraint = "Never send a report without approval.", next = "Next action: check the filing receipt before further work.";
  const records = [{ kind: "owner", text: constraint }, { kind: "owner", text: next }, ...Array.from({ length: 100 }, (_, i) => ({ kind: "tool", toolName: names[i % names.length], text: `Filing reference: ${letters(i)}. Register reviewed.` }))];
  const passes = await replayLedgerSelection(records, { entriesForPass: citeTool });
  expect(passes.map(p => p.deltaEntries)).toEqual([1, 0, 1]);
  for (const text of [constraint, next]) {
    expect(ownerOffers(passes, text)).toEqual([1, 2]);
    const id = passes[0].records.find(r => r.text === text).recordId;
    expect(passes[1].offered).toContainEqual(expect.objectContaining({ recordId: id, owner: true, text }));
    expect(passes[2].offered.some(row => row.recordId === id)).toBe(false);
  }
}, 60000);

it("keeps identifier tool evidence under an owner flood after a prior exists, with an eighty percent fitted-span tool floor each pass", async () => {
  const records = [];
  for (let i = 0; i < 128; i++) {
    if (i < 96) records.push({ kind: "owner", text: `Keep the ${letters(i)} exhibit on the review list.` });
    records.push({ kind: "tool", toolName: names[i % names.length], text: `Filing reference: ${letters(i)}. Register reviewed.` });
  }
  const expected = new Set(records.filter(r => r.kind === "tool").map(r => r.text));
  const passes = await replayLedgerSelection(records, { entriesForPass: citeTool });
  expect(passes[0].published).toBe(true); // p2 and p3 have a genuine prior, not an empty fake
  for (const pass of passes) {
    const tools = pass.offered.filter(row => row.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(Math.ceil(pass.offered.length * 0.8));
    expect(tools.length).toBeGreaterThan(0);
    for (const row of tools) {
      expect(expected.has(row.text)).toBe(true);
      expect(pass.records).toContainEqual(expect.objectContaining({ recordId: row.recordId, kind: "tool", text: row.text }));
    }
  }
}, 60000);

it("offers a short late cancellation within three passes of a tool and identifier flood", async () => {
  const cancellation = "Cancel the willow report; wait for my confirmation before any work.";
  const records = Array.from({ length: 180 }, (_, i) => ({ kind: "tool", toolName: names[i % names.length], text: `Filing reference: ${letters(i)}.\n\n${words}` }));
  records.push({ kind: "owner", text: cancellation });
  const passes = await replayLedgerSelection(records, { entriesForPass: citeTool });
  expect(ownerOffers(passes, cancellation).length).toBeGreaterThan(0);
  const pass = passes.find(p => p.offered.some(row => row.owner && row.text === cancellation));
  const source = pass.records.find(r => r.text === cancellation);
  expect(source.inputId).toBe("fictional-input-180");
  expect(pass.offered).toContainEqual(expect.objectContaining({ recordId: source.recordId, owner: true, text: cancellation }));
}, 60000);
