import { useEffect, useState } from "react";
import css from "../styles.css?raw";
import iconSource from "../components/Icon.tsx?raw";
import { Icon, type IconName } from "../components/Icon";

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
const root = Array.from(sheet.cssRules).find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === ":root");
export const tokens = root ? Array.from(root.style).filter((name) => name.startsWith("--")) : [];
const groups: Record<string, string[]> = {
  "Surfaces & text": ["app-bg", "panel", "surface", "surface-raised", "surface-subtle", "surface-hover", "rail", "text", "text-soft", "text-muted", "line", "line-strong"],
  "Accent & identity": ["accent", "accent-strong", "on-accent", "accent-soft", "accent-glow", "brand-primary", "brand-secondary", "brand-tail", "cat-4"],
  "Status": ["danger", "danger-soft", "warning", "success"],
  "Shadows": ["shadow-sm", "shadow-lg"],
  "Radii": ["radius-sm", "radius-md", "radius-lg"],
  "Typography": ["font-mono"],
};
const named = new Set(Object.values(groups).flat().map((name) => `--${name}`));
export const groupedTokens = { ...groups, Other: tokens.filter((name) => !named.has(name)).map((name) => name.slice(2)) };
export const variable = (name: string) => `var(--${name})`;
export function useResolvedTokens() {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  useEffect(() => {
    const update = () => setResolved(Object.fromEntries(tokens.map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-console-theme", "data-storybook-scheme"] });
    return () => observer.disconnect();
  }, []);
  return resolved;
}
export function ColorCatalog() {
  const resolved = useResolvedTokens();
  const colorNames = Object.values(groups).slice(0, 3).flat();
  return <main><h1>Console colors</h1><p>Live from the product CSS. Use the palette and appearance toolbar to inspect all four themes in light or dark.</p>
    {Object.entries(groupedTokens).map(([role, names]) => {
      const values = names;
      if (values.length === 0) return null;
      return <section key={role}><h2>{role}</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 16 }}>
        {values.map((name) => <div key={name} style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 12, minWidth: 0 }}>
          <div style={{ height: 68, borderRadius: 8, background: colorNames.includes(name) ? variable(name) : "var(--surface)", border: "1px solid var(--line)" }} />
          <strong style={{ display: "block", overflowWrap: "anywhere" }}>--{name}</strong><code style={{ overflowWrap: "anywhere" }}>{resolved[`--${name}`]}</code>
        </div>)}
      </div></section>;
    })}
    <p>All {tokens.length} root custom properties are cataloged across Colors, Typography, Radii &amp; Shadows, and the Other group.</p>
  </main>;
}
export function TypographyCatalog() {
  const resolved = useResolvedTokens();
  return <main><h1>Typography</h1><h1>Display / console heading</h1><h2>Section heading</h2><h3>Subsection heading</h3><p>Body: Morgan is drafting a Garden planner.</p><small>Small: supporting metadata and status</small><pre style={{ fontFamily: variable("font-mono") }}>Mono: plan-001 · 2026-01-15</pre><code>--font-mono: {resolved["--font-mono"]}</code></main>;
}
export function SpacingCatalog() {
  return <main><h1>Spacing</h1><p>The console uses component-local px/rem spacing; there are no root spacing custom properties.</p>{[4, 8, 12, 16, 24, 32, 48].map((size) => <div key={size} style={{ display: "flex", alignItems: "center", gap: 12, padding: 6 }}><code>{size}px</code><span style={{ width: size * 4, height: 16, background: variable("accent") }} /></div>)}</main>;
}
export function ShapeCatalog() {
  const resolved = useResolvedTokens();
  return <main><h1>Radii &amp; shadows</h1>{["radius-sm", "radius-md", "radius-lg", "shadow-sm", "shadow-lg"].map((name) => <div key={name} style={{ margin: 28, padding: 28, display: "inline-block", background: variable("surface-raised"), borderRadius: name.startsWith("radius") ? variable(name) : 12, boxShadow: name.startsWith("shadow") ? variable(name) : "none", border: "1px solid var(--line)" }}><code>--{name}</code><p>{resolved[`--${name}`]}</p></div>)}</main>;
}
export function MotionCatalog() { return <main><h1>Motion &amp; layering</h1><p>Transitions and z-index are authored as component rules in styles.css, not root custom properties. Motion responds to <code>prefers-reduced-motion</code>. Inspect individual interactive stories to see their authored transitions and stacking order.</p></main>; }
const iconNames = Array.from(iconSource.matchAll(/^\s*\|\s*"([^"]+)"/gm), (match) => match[1] as IconName);
export function IconCatalog() { return <main><h1>Iconography</h1><p>All {iconNames.length} names are extracted from the IconName union in Icon.tsx.</p><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 16 }}>{iconNames.map((name) => <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}><Icon name={name} size={24} /><code>{name}</code></div>)}</div></main>; }
