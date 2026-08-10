#!/usr/bin/env node
/**
 * Enforce the token tiers.
 *
 * A three-tier system is only worth the ceremony if the tiers hold. They rot the same way
 * every time: someone needs a colour in a hurry, reaches past the roles for `bg-slate-800`
 * or a raw hex, and it works — so the next person does it too. Six months on, half the app
 * ignores the theme and dark mode has holes in it.
 *
 * Three rules, checked mechanically:
 *   1. No raw Tailwind colour-scale utilities in src/ (bg-slate-800, text-red-600, …).
 *      Roles carry their own theme; a raw scale does not, and it silently wins.
 *   2. No `dark:` colour variants. A role is already correct in both themes, so a
 *      `dark:` beside one means the role is being overridden — the bug this system exists
 *      to remove.
 *   3. Tier 1 stays private: `--wh-ref-*` may only be read inside src/index.css, where
 *      tier 2 maps it to meaning. Components read roles, never the palette.
 *
 * Run: npm run check:tokens
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const TOKENS_FILE = join(SRC, 'index.css');

const SCALES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|brand';
const PROPS = 'bg|text|border|ring|divide|placeholder|outline|from|to|via|decoration|accent|fill|stroke|shadow';

const RULES = [
  {
    id: 'raw-colour-scale',
    re: new RegExp(`\\b(?:${PROPS})-(?:${SCALES})-\\d{2,3}\\b`, 'g'),
    hint: 'use a system role (bg-surface, text-on-surface-variant, text-danger-text, …)',
  },
  {
    id: 'dark-variant',
    re: new RegExp(`\\bdark:(?:[a-z-]+:)*(?:${PROPS})-`, 'g'),
    hint: 'roles already carry the theme — delete the dark: variant',
  },
  {
    id: 'reference-tier-leak',
    re: /var\(\s*--wh-ref-/g,
    hint: 'reference tokens are private to index.css; go through a --wh-sys-* role',
  },
];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const violations = [];
for (const file of walk(SRC)) {
  if (!/\.(tsx?|css)$/.test(file)) continue;
  const isTokenFile = file === TOKENS_FILE;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  for (const rule of RULES) {
    // index.css IS tier 1 and 2, so it is the one file allowed to name them.
    if (isTokenFile) continue;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(rule.re)) {
        violations.push({ file: relative(SRC, file), line: i + 1, rule: rule.id, match: m[0], hint: rule.hint });
      }
    });
  }
}

if (violations.length) {
  console.error(`${violations.length} token violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.match}`);
    console.error(`    → ${v.hint}`);
  }
  process.exit(1);
}
console.log('Token tiers hold: no raw colour scales, no dark: overrides, no reference-tier leaks.');
