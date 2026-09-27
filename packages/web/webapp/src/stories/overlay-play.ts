import { waitFor } from "@testing-library/dom";

/** Open the actual product overlay in the Storybook iframe, including its portal. */
export async function openOverlay(canvasElement: HTMLElement, trigger: string, popup: string): Promise<void> {
  await waitFor(() => {
    const button = canvasElement.querySelector<HTMLElement>(trigger);
    if (!button) throw new Error(`Story trigger not mounted: ${trigger}`);
    button.click();
  });
  await waitFor(() => {
    const content = canvasElement.ownerDocument.querySelector(popup);
    if (!content || content.getClientRects().length === 0) throw new Error(`Story popup not visible: ${popup}`);
  }, { timeout: 6000 });
}

export async function waitForOverlay(canvasElement: HTMLElement, selector: string): Promise<void> {
  await waitFor(() => {
    const content = canvasElement.ownerDocument.querySelector(selector);
    if (!content || content.getClientRects().length === 0) throw new Error(`Story popup state not visible: ${selector}`);
  }, { timeout: 6000 });
}
