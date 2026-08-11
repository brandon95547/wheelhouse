#!/usr/bin/env node
/**
 * End-to-end check of the chain that runs inside the tab: eBay-shaped DOM -> parser.js
 * -> classifier -> the per-brand rollup that gets sent to Wheelhouse.
 *
 * Deliberately runs against a FIXTURE, not against eBay. Two reasons: a test that hits a
 * live site fails for reasons that have nothing to do with the code, and the real scan
 * is supposed to run in the user's own signed-in session, not from a build machine.
 * What this proves is the wiring — that a card in eBay's current markup comes out the
 * far end as a classified brand. Whether those selectors still match TODAY'S eBay is a
 * question only a real page can answer; see README, "Checking the selectors".
 *
 *   node tools/test-pipeline.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservedIndex, classify, summarise, discoverCandidates } from '../lib/classify.js';
import { parsePrice, isPreOwned, soldSearchUrl, categoryIdFromUrl } from '../lib/ebay-url.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------- a very small DOM, hand-rolled */
/* Enough of the API for parser.js: querySelectorAll with class/tag selectors,
   textContent, getAttribute, matches. Avoids a jsdom dependency for a fixture test. */

class El {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = children;
    this.ownText = text;
    for (const c of children) c.parent = this;
  }
  get classList() { return (this.attrs.class ?? '').split(/\s+/).filter(Boolean); }
  get textContent() {
    return [this.ownText, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  get id() { return this.attrs.id ?? ''; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  matches(sel) { return matchOne(this, sel); }
  querySelectorAll(selector) {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const node of this.descendants()) {
      if (parts.some((p) => matchOne(node, p)) && !out.includes(node)) out.push(node);
    }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

/** Handles the shapes parser.js actually uses: `li.s-card`, `.a .b`, `a[href*="x"]`. */
function matchOne(node, selector) {
  const steps = selector.trim().split(/\s+/);
  const last = steps[steps.length - 1];
  if (!matchSimple(node, last)) return false;
  let cursor = node.parent;
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (cursor) {
      if (matchSimple(cursor, steps[i])) { found = true; cursor = cursor.parent; break; }
      cursor = cursor.parent;
    }
    if (!found) return false;
  }
  return true;
}

function matchSimple(node, sel) {
  const attr = sel.match(/^([a-z]*)\[([\w-]+)([*^$]?=)"?([^\]"]*)"?\]$/i);
  if (attr) {
    const [, tag, name, op, value] = attr;
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (!op) return true;
    if (op === '*=') return actual.includes(value);
    if (op === '^=') return actual.startsWith(value);
    if (op === '=') return actual === value;
    return false;
  }
  const m = sel.match(/^([a-z]*)((?:\.[\w-]+)*)$/i);
  if (!m) return false;
  const [, tag, classes] = m;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  return classes.split('.').filter(Boolean).every((c) => node.classList.includes(c));
}

/* ------------------------------------------------------------------- fixture */

const card = (title, price, condition, id) =>
  new El('li', { class: 's-card', 'data-itemid': id }, [
    new El('div', { class: 's-card__title' }, [], title),
    new El('div', { class: 's-card__price' }, [], price),
    new El('div', { class: 's-card__subtitle' }, [], condition),
    new El('div', { class: 's-card__caption' }, [], 'Sold Aug 3, 2026'),
    new El('a', { class: 'su-link', href: `https://www.ebay.com/itm/${id}` }, [], ''),
  ]);

const FIXTURE = [
  ['Nike SB Dunk Low Pro Mens 10 Panda', 'US $184.00', 'Pre-owned', '295012345678'],
  ['Nike Revolution 6 Mens Running Shoes 10.5', 'US $41.99', 'Pre-owned', '295012345679'],
  ['Alden 990 Cordovan Plain Toe Blucher 10D', 'US $412.00', 'Pre-owned', '295012345680'],
  ['Red Wing 875 Moc Toe Boots Mens 10D', 'US $168.50', 'Pre-owned', '295012345681'],
  ['Faded Glory Mens Casual Shoes Size 10', 'US $44.00', 'Pre-owned', '295012345682'],
  ['New Balance 990v5 Made in USA Mens 11', 'US $139.00', 'Pre-owned', '295012345683'],
  ['Oliberte Mens Leather Boots 10 Brown', 'US $72.00', 'Pre-owned', '295012345684'],
  ['Oliberte Womens Ankle Boot 8 Tan', 'US $66.00', 'Pre-owned', '295012345685'],
  ['Oliberte Mens Chukka 11 Black', 'US $58.00', 'Pre-owned', '295012345686'],
  ['Shop on eBay', 'US $20.00', '', '000000000000'],
];

const results = new El('ul', { class: 'srp-results' }, FIXTURE.map((a) => card(...a)));
const body = new El('body', {}, [results]);

globalThis.document = {
  body,
  title: 'Sold listings',
  querySelectorAll: (s) => body.querySelectorAll(s),
  querySelector: (s) => body.querySelector(s),
};
globalThis.location = {
  href: 'https://www.ebay.com/sch/i.html?_nkw=mens+shoes&LH_Sold=1&LH_Complete=1',
  hostname: 'www.ebay.com',
  pathname: '/sch/i.html',
  search: '?_nkw=mens+shoes&LH_Sold=1&LH_Complete=1',
};

/* ------------------------------------------------------------------- run it */

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
};

// parser.js is an IIFE that assigns globalThis.WheelhouseParser.
new Function(readFileSync(resolve(ROOT, 'content/parser.js'), 'utf8'))();
const parsed = globalThis.WheelhouseParser.extractAll();

console.log('parser');
check('finds every real card and drops the "Shop on eBay" filler', parsed.found, FIXTURE.length - 1);
check('reads a price', parsed.listings[0].soldPrice, 'US $184.00');
check('reads the condition', parsed.listings[0].condition, 'Pre-owned');
check('reads the item id', parsed.listings[0].itemId, '295012345678');

// The brand vocabulary a real scan gets: eBay's own Brand facet for this search.
const index = buildObservedIndex([
  { name: 'Nike' }, { name: 'Alden' }, { name: 'Red Wing' }, { name: 'New Balance' },
]);

const MIN = 40;
const rows = [];
const unlisted = [];
for (const listing of parsed.listings) {
  const priceValue = parsePrice(listing.soldPrice);
  if (priceValue !== null && priceValue < MIN) continue;
  if (isPreOwned(listing.condition) === false) continue;
  const classification = classify(index, listing);
  const row = { ...listing, priceValue, classification };
  rows.push(row);
  if (classification.verdict === 'unlisted') unlisted.push(row);
}

console.log('\nclassification');
const verdicts = Object.fromEntries(
  ['observed', 'model-missing', 'unlisted'].map((v) => [v, rows.filter((r) => r.classification.verdict === v).length]),
);
// Every facet brand is reported and none is judged — including Nike Revolution, which
// the old catalog rejected. Whether it is worth money is now decided from its price.
check('5 identified (SB Dunk, Revolution, Alden, Red Wing, 990v5)', verdicts.observed, 5);
check('nothing is rejected on a model any more', verdicts['model-missing'], 0);
check('4 unlisted (Faded Glory + 3 Oliberte)', verdicts.unlisted, 4);

const brands = summarise(rows);
console.log('\nrollup sent to Wheelhouse');
for (const b of brands) {
  console.log(`  ${b.brand.padEnd(14)} ${String(b.soldCount).padStart(2)} sold  median $${b.medianPrice}  ${b.tier}${b.models.length ? `  [${b.models.map((m) => m.name).join(', ')}]` : ''}`);
}
check('Faded Glory never reaches the rollup', brands.some((b) => /faded/i.test(b.brand)), false);
check('Nike is present with both its sales counted', brands.find((b) => b.brand === 'Nike')?.soldCount, 2);

const candidates = discoverCandidates(unlisted, { minCount: 3 });
console.log('\ndiscovery');
check('Oliberte surfaces as a candidate', candidates[0]?.name, 'oliberte');
check('Faded Glory does not (only one sale)', candidates.some((c) => /faded/.test(c.name)), false);

console.log('\nurl building');
const url = soldSearchUrl({ terms: 'mens shoes', minPrice: 40, usedOnly: true, page: 2 });
for (const expect of ['_nkw=mens+shoes', 'LH_Sold=1', 'LH_Complete=1', 'LH_ItemCondition=3000', '_udlo=40', '_ipg=200', '_pgn=2']) {
  check(`carries ${expect}`, url.includes(expect), true);
}
check('omits _sacat when no category is pinned', url.includes('_sacat'), false);
check('pins a category when given one', soldSearchUrl({ terms: 'x', categoryId: '93427' }).includes('_sacat=93427'), true);
check('reads _sacat off a browse URL', categoryIdFromUrl('https://www.ebay.com/b/Mens-Shoes/93427/bn_16givnq'), '93427');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks pass');
process.exit(failures ? 1 : 0);
