#!/usr/bin/env node
/**
 * Audit the colour system in src/index.css against WCAG 2.1.
 *
 * The point of Material's `on-` roles is a GUARANTEE: content placed on a role is
 * readable. A guarantee nobody checks is a convention, and conventions rot — someone
 * nudges a hex to taste and the pair silently drops to 3.9:1, which no reviewer catches
 * by eye. This parses the real token file and proves each pair, in both themes.
 *
 * Two thresholds, both from the spec:
 *   1.4.3 Contrast (Minimum) — 4.5:1 for text.
 *   1.4.11 Non-text Contrast — 3:1 for the boundary of a UI component (an input border).
 *
 * Exempt, deliberately: `on-surface-disabled` (1.4.3 excludes inactive components) and
 * `outline-variant`, which draws decorative dividers rather than component boundaries.
 *
 * Run: npm run check:contrast
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CSS = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css');
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/* ---- colour maths ---- */
const toRgb = (hex) => {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const [r, g, b] = toRgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/* ---- parse the token file ---- */
const css = readFileSync(CSS, 'utf8');

/** Every variable declared in blocks opened by `selector`.
 *
 * Line-based rather than a single regex: the file has more than one `:root` block (the
 * reference tier and the light system tier are deliberately separate), and a block can be
 * preceded by a comment, so "starts at column 0, ends at a line that is just `}`" is the
 * only rule that holds for all of them. Later declarations win, as in CSS. */
function blockVars(selector) {
  const vars = {};
  const lines = css.split('\n');
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      if (new RegExp(`^${selector}\\s*\\{`).test(line)) depth = 1;
      continue;
    }
    if (/^\}/.test(line)) { depth = 0; continue; }
    const d = line.match(/(--[\w-]+)\s*:\s*([^;]+);/);
    if (d) vars[d[1]] = d[2].trim();
  }
  return vars;
}

const rootVars = blockVars(':root');
const darkVars = { ...rootVars, ...blockVars('\\.dark') };
if (Object.keys(rootVars).length < 20) {
  console.error('Parsed almost no tokens from index.css — the parser and the file have drifted.');
  process.exit(2);
}

/** Resolve var() indirection down to a hex. */
function hex(vars, name, seen = new Set()) {
  const raw = vars[name];
  if (!raw) throw new Error(`token ${name} is not defined`);
  if (raw.startsWith('#')) return raw;
  const ref = raw.match(/var\((--[\w-]+)\)/);
  if (ref) {
    if (seen.has(ref[1])) throw new Error(`circular token reference at ${name}`);
    seen.add(ref[1]);
    return hex(vars, ref[1], seen);
  }
  throw new Error(`token ${name} is not a colour: ${raw}`);
}

/* ---- what must hold ---- */
const ROLES = ['primary', 'success', 'info', 'warning', 'danger', 'accent'];
// Every surface a role's text can land on. on-surface-* must clear AA on all of them,
// which is why the neutral ramp is lifted off the palette sheet's tertiary/muted tones.
const SURFACES = ['surface', 'background', 'surface-variant', 'surface-container'];

function checks(vars) {
  const out = [];
  const V = (n) => hex(vars, `--wh-sys-${n}`);

  out.push(['text', 'on-background', 'background', V('on-background'), V('background')]);
  for (const s of SURFACES) {
    for (const tier of ['on-surface', 'on-surface-variant', 'on-surface-muted']) {
      out.push(['text', tier, s, V(tier), V(s)]);
    }
  }
  for (const r of ROLES) {
    // A filled control and each of its states must carry its own on-colour.
    for (const state of ['', '-hover', '-active']) {
      out.push(['text', `on-${r}`, `${r}${state}`, V(`on-${r}`), V(`${r}${state}`)]);
    }
    out.push(['text', `on-${r}-container`, `${r}-container`, V(`on-${r}-container`), V(`${r}-container`)]);
    // The `-text` roles exist precisely because the base hue fails on dark surfaces.
    for (const s of SURFACES) {
      out.push(['text', `${r}-text`, s, V(`${r}-text`), V(s)]);
    }
  }
  // An input's border is the boundary of a UI component: 1.4.11, not 1.4.3.
  out.push(['non-text', 'outline', 'surface', V('outline'), V('surface')]);
  out.push(['non-text', 'outline', 'background', V('outline'), V('background')]);
  return out;
}

let failed = 0;
for (const [theme, vars] of [['light', rootVars], ['dark', darkVars]]) {
  const rows = checks(vars);
  const bad = rows.filter(([kind, , , fg, bg]) =>
    contrast(fg, bg) < (kind === 'text' ? AA_TEXT : AA_NON_TEXT));
  const worst = Math.min(...rows.map(([, , , f, b]) => contrast(f, b)));
  console.log(
    `${theme.padEnd(5)} ${rows.length} pairs · ${bad.length ? `${bad.length} FAILING` : 'all pass'} · worst ${worst.toFixed(2)}:1`,
  );
  for (const [kind, fg, bg, fgHex, bgHex] of bad) {
    failed += 1;
    const need = kind === 'text' ? AA_TEXT : AA_NON_TEXT;
    console.log(`  ✗ ${fg} on ${bg}: ${contrast(fgHex, bgHex).toFixed(2)}:1 (needs ${need}) — ${fgHex} / ${bgHex}`);
  }
}

if (failed) {
  console.error(`\n${failed} pair(s) below threshold. Fix the token, not the threshold.`);
  process.exit(1);
}
console.log('\nAll on-/container pairs meet WCAG AA in both themes.');
