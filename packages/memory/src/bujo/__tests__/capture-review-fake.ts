/** Test fake for the capture review pass: keep every assistant line and add no preference. */
export function neutralCaptureReview(prompt: string): string {
  const lines = JSON.parse(prompt.slice(prompt.lastIndexOf("LINES:\n") + 7)) as { index: number; source: string }[];
  return JSON.stringify({ decisions: lines.map(({ index, source }) => ({ index, decision: source === "user" ? "none" : "keep" })) });
}
