import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import source from "../styles.css?raw";

// Enumerate the canonical root declaration instead of duplicating token values.
const sheet = new CSSStyleSheet();
sheet.replaceSync(source);
const root = Array.from(sheet.cssRules).find((rule): rule is CSSStyleRule =>
  rule instanceof CSSStyleRule && rule.selectorText === ":root",
);
const tokens = root ? Array.from(root.style).filter((name) => name.startsWith("--")) : [];
const groups: Record<string, string[]> = {
  "Surfaces & text": ["app-bg", "panel", "surface", "surface-raised", "surface-subtle", "surface-hover", "rail", "text", "text-soft", "text-muted", "line", "line-strong"],
  "Accent & brand": ["accent", "accent-strong", "on-accent", "accent-soft", "accent-glow", "brand-primary", "brand-secondary", "brand-tail", "cat-4"],
  "Status": ["danger", "danger-soft", "warning", "success"],
};
const cssVar = (token: string) => `var(--${token})`;
function Foundations() {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  useEffect(() => {
    const update = () => setResolved(Object.fromEntries(tokens.map((name) =>
      [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()],
    )));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-console-theme", "data-storybook-scheme"] });
    return () => observer.disconnect();
  }, []);
  const section = (title: string, names: string[]) => <section key={title} style={{ marginBottom: 36 }}>
    <h2>{title}</h2><div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      {names.filter((name) => tokens.includes(`--${name}`)).map((name) => <div key={name} style={{ width: 180 }}>
        <div style={{ height: 68, background: cssVar(name), border: "1px solid var(--line)", borderRadius: 8 }} />
        <strong>--{name}</strong><br /><code>{resolved[`--${name}`]}</code>
      </div>)}
    </div>
  </section>;
  return <main style={{ maxWidth: 1200, margin: "auto" }}>
    <h1>Console foundations</h1><p>Choose a palette and appearance in the toolbar. Values come from the live console CSS.</p>
    {Object.entries(groups).map(([title, names]) => section(title, names))}
    <section><h2>Typography</h2><h1>Display / console heading</h1><h2>Section heading</h2><h3>Subsection heading</h3><p>Body: Garden planner is ready for Morgan.</p><small>Small: supporting metadata and status.</small><pre style={{ fontFamily: cssVar("font-mono") }}>Monospace: job-001 · 2026-01-15</pre></section>
    <section><h2>Spacing</h2><p>Samples in px; component spacing is authored directly in styles.css, not tokenized.</p>{[4, 8, 12, 16, 24, 32].map((size) => <div key={size} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}><code>{size}px</code><span style={{ width: size * 4, height: 14, background: cssVar("accent") }} /></div>)}</section>
    <section><h2>Radii</h2>{["radius-sm", "radius-md", "radius-lg"].map((name) => <div key={name} style={{ display: "inline-block", padding: 24, margin: 8, borderRadius: cssVar(name), background: cssVar("surface-raised"), border: "1px solid var(--line)" }}>--{name} · {resolved[`--${name}`]}</div>)}</section>
    <section><h2>Shadows</h2>{["shadow-sm", "shadow-lg"].map((name) => <div key={name} style={{ display: "inline-block", padding: 28, margin: 20, boxShadow: cssVar(name), background: cssVar("surface-raised") }}>--{name}</div>)}</section>
    <section><h2>Motion & stacking</h2><p>Transitions and z-index are local component rules in styles.css, not CSS custom properties. Reduced-motion preferences are respected by the product stylesheet.</p></section>
  </main>;
}
export default { title: "Foundations/Tokens", component: Foundations, tags: ["autodocs"] } satisfies Meta<typeof Foundations>;
export const AllThemes: StoryObj<typeof Foundations> = {};
