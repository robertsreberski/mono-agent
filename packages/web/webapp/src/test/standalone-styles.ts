/**
 * Chromium's test iframe is a browser tab. Enable the actual standalone CSS
 * rules (without copying their declarations) for synthetic layout assertions.
 * This does not emulate installed-system chrome or change matchMedia results.
 */
export function forceStandaloneStyles(): () => void {
  const changed: { rule: CSSMediaRule; media: string }[] = [];
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("(display-mode: standalone)")) {
        changed.push({ rule, media: rule.media.mediaText });
        // Preserve other conditions, such as viewport-width restrictions.
        rule.media.mediaText = rule.media.mediaText.replaceAll("(display-mode: standalone)", "(min-width: 0px)");
      }
    }
  }
  if (changed.length === 0) throw new Error("Standalone stylesheet rules not found");
  return () => {
    for (const { rule, media } of changed) rule.media.mediaText = media;
  };
}
