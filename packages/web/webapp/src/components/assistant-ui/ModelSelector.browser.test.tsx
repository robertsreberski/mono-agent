import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import "../../styles.css";
import { ModelSelector } from "./ModelSelector";
import { selectorModels } from "./ModelSelector.fixtures";

function Example({ settings = false, middle = false }: { settings?: boolean; middle?: boolean }) {
  const [value, setValue] = useState("");
  const [effort, setEffort] = useState("medium");
  const [context, setContext] = useState(true);
  return <div className={settings ? "settings-screen" : "composer-actions"}
    style={{ position: "fixed", left: 16, right: 16, ...(middle ? { top: "50%" } : settings ? { top: 100 } : { bottom: 20 }) }}>
    <ModelSelector models={selectorModels} value={value} effort={effort} context1M={context}
      onValueChange={setValue} onEffortChange={setEffort} onContext1MChange={setContext}
      onReset={() => { setValue(""); setEffort(""); }} agentDefaultId="atlas:standard"
      showModelChangeHint side={settings ? "bottom" : "top"} />
  </div>;
}
const shots = import.meta.env.VITE_MODEL_SELECTOR_SHOTS as string | undefined;
const capture = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

/** Visibility includes clipping ancestors, not just the element's viewport rect. */
function insideVisibleBox(element: Element, popup: Element) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(-1);
  expect(rect.top).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  let ancestor = element.parentElement;
  while (ancestor) {
    const bounds = ancestor.getBoundingClientRect();
    const style = getComputedStyle(ancestor);
    if (ancestor === popup || /(auto|scroll|hidden|clip)/u.test(style.overflowX)) {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    }
    if (ancestor === popup || /(auto|scroll|hidden|clip)/u.test(style.overflowY)) {
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    }
    if (ancestor === popup) break;
    ancestor = ancestor.parentElement;
  }
}
afterEach(async () => { cleanup(); await commands.emulateColorScheme(null); await page.viewport(1440, 1000); });

const sizes = [[320, 568], [375, 667], [390, 844], [430, 932], [844, 390], [1280, 720], [1280, 800], [1440, 900]] as const;
it.each(sizes.flatMap(([width, height]) => [false, true].map((settings) => ({ width, height, settings }))))(
  "keeps the worst-case selector reachable at $width×$height (settings=$settings)", async ({ width, height, settings }) => {
    await page.viewport(width, height);
    await commands.emulateColorScheme("dark");
    render(<Example settings={settings} />);
    const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog");
    const search = within(popup).getByRole("combobox", { name: "Search models" });
    const close = within(popup).getByRole("button", { name: "Close" });
    const reset = within(popup).getByRole("button", { name: "Reset to agent default" });
    const context = within(popup).getByRole("radio", { name: "1M" });
    const fixed = [search, context, close, reset];
    const selectedEffort = within(popup).getByRole("radio", { name: "Medium" });
    await waitFor(() => [...fixed, selectedEffort].forEach((control) => insideVisibleBox(control, popup)));
    expect(popup.scrollHeight).toBeLessThanOrEqual(popup.clientHeight);
    expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
    const name = `${settings ? "settings" : "composer"}-dark-${width}x${height}`;
    await capture(name);
    // Every provider/effort is reachable by horizontal scrolling; vertical size
    // stays constant and the footer never leaves the visible box.
    for (const groupName of ["Filter by provider", "Reasoning effort"]) {
      const group = within(popup).getByRole("radiogroup", { name: groupName });
      for (const radio of within(group).getAllByRole("radio")) {
        radio.scrollIntoView({ block: "nearest", inline: "nearest" });
        await waitFor(() => insideVisibleBox(radio, popup));
        fixed.forEach((control) => insideVisibleBox(control, popup));
        if (width <= 560 || height === 390) expect(radio.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      group.scrollLeft = 0;
    }
    const list = popup.querySelector<HTMLElement>('[data-slot="model-selector-list"]')!;
    for (const model of within(popup).getAllByRole("option")) {
      model.scrollIntoView({ block: "nearest" });
      await waitFor(() => insideVisibleBox(model, popup));
      fixed.forEach((control) => insideVisibleBox(control, popup));
    }
    const hint = within(popup).getByText(/Changing the model rebuilds context/u);
    hint.scrollIntoView({ block: "nearest" });
    await waitFor(() => insideVisibleBox(hint, popup));
    fixed.forEach((control) => insideVisibleBox(control, popup));
    expect(list.scrollTop).toBeGreaterThan(0);
    if (!settings && width === 390) await capture("composer-dark-390x844-scrolled-list");
    fireEvent.change(search, { target: { value: "no-such-model" } });
    await waitFor(() => insideVisibleBox(within(popup).getByText("No models match."), popup));
    fixed.forEach((control) => insideVisibleBox(control, popup));
    if (!settings && width === 390) await capture("composer-dark-390x844-empty-search");
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);
it.each([[390, 844], [1280, 800]])("captures light theme %ix%i", async (width, height) => {
  await page.viewport(width, height);
  await commands.emulateColorScheme("light");
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
  const popup = await screen.findByRole("dialog");
  await waitFor(() => insideVisibleBox(within(popup).getByRole("button", { name: "Close" }), popup));
  await capture(`composer-light-${width}x${height}`);
});
it("preserves keyboard navigation and restores focus on Escape", async () => {
  await page.viewport(375, 667);
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Model and reasoning effort" });
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  const popup = await screen.findByRole("dialog");
  const search = within(popup).getByRole("combobox", { name: "Search models" });
  await waitFor(() => expect(search).toHaveFocus());
  await userEvent.keyboard("{End}{Enter}");
  expect(trigger).toHaveTextContent("Summit Compact");
  await userEvent.keyboard("{Home}{Enter}");
  expect(trigger).toHaveTextContent("Default · Atlas Standard");
  const efforts = within(popup).getByRole("radiogroup", { name: "Reasoning effort" });
  const medium = within(efforts).getByRole("radio", { name: "Medium" });
  medium.focus();
  await userEvent.keyboard("{ArrowRight}");
  const high = within(efforts).getByRole("radio", { name: "High" });
  expect(high).toBeChecked();
  expect(high).toHaveFocus();
  insideVisibleBox(high, popup);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses collision space for a settings trigger in the middle of a short desktop", async () => {
  await page.viewport(1280, 720);
  render(<Example settings middle />);
  fireEvent.click(screen.getByRole("button", { name: "Model and reasoning effort" }));
  const popup = await screen.findByRole("dialog");
  const close = within(popup).getByRole("button", { name: "Close" });
  await waitFor(() => insideVisibleBox(close, popup));
  expect(popup.getBoundingClientRect().height).toBeLessThan(360);
  for (const model of within(popup).getAllByRole("option")) {
    model.scrollIntoView({ block: "nearest" });
    await waitFor(() => insideVisibleBox(model, popup));
    insideVisibleBox(close, popup);
  }
});
