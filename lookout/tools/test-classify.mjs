#!/usr/bin/env node
/**
 * Prove the classifier does its one remaining job: name the brand, and claim nothing else.
 *
 * The catalog is gone. There is no shipped opinion about what is worth buying, so there
 * is nothing here asserting that Nike Revolution is landfill — that judgement belongs to
 * a person looking at the brand book, not to this file. What IS asserted is the thing a
 * silent failure would destroy: that the brand behind a listing is identified correctly,
 * from eBay's own facet, including the cases where naive matching gets it wrong.
 *
 *   node tools/test-classify.mjs
 */
import { buildIndex, buildObservedIndex, classify, discoverCandidates, summarise } from '../lib/classify.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* ------------------------------------------------------------------ observed
 *
 * The shipped path. Brand names come from eBay's Brand facet for the search being run.
 */
console.log('observed brands, named from the facet');

const FACET = [
  { name: 'Nike' },
  { name: 'New Balance' },
  { name: 'Dr. Martens' },
  { name: 'A Bathing Ape (BAPE)' },
  { name: 'Ralph Lauren' },
  { name: 'Polo Ralph Lauren' },
  { name: 'Unbranded' },
];
const observed = buildObservedIndex(FACET);

const named = (title) => {
  const r = classify(observed, { title });
  return [r.verdict, r.brand];
};

check('a common brand is reported, not rejected — no opinion ships any more',
  named('Nike Revolution 6 Mens Running Shoes 10.5 Black'), ['observed', 'Nike']);
check('the same brand with a hyped model reads identically — still just a name',
  named('Nike SB Dunk Low Pro Mens 10 Panda'), ['observed', 'Nike']);
check('multi-word brand matched whole',
  named('New Balance 574 Mens 10 Navy'), ['observed', 'New Balance']);
check('punctuation in the facet name folded away',
  named('Dr Martens 1460 Mens 9 Black Smooth'), ['observed', 'Dr. Martens']);
check('parenthesised facet label matches its bare form',
  named('A Bathing Ape BAPE STA Mens 9 Green'), ['observed', 'A Bathing Ape (BAPE)']);
check('longest facet name wins over the shorter one inside it',
  named('Polo Ralph Lauren Purple Label Mens 10'), ['observed', 'Polo Ralph Lauren']);
check('a brand absent from the facet is unlisted, not guessed',
  named('Faded Glory Mens Brown Casual Shoes Size 10'), ['unlisted', null]);
check('eBay’s "Unbranded" bucket is not a brand',
  named('Unbranded Mens Leather Boots 10'), ['unlisted', null]);

/* -------------------------------------------------------------------- rollup */
console.log('\nrollup sent to Wheelhouse');

const rows = [
  { title: 'Nike SB Dunk Low Mens 10', priceValue: 180, itemUrl: 'a' },
  { title: 'Nike SB Dunk High Mens 11', priceValue: 220, itemUrl: 'b' },
  { title: 'Nike Revolution 6 Mens 10', priceValue: 42, itemUrl: 'c' },
  { title: 'New Balance 990v5 Mens 11', priceValue: 139, itemUrl: 'd' },
  { title: 'Faded Glory Mens Shoes 10', priceValue: 12, itemUrl: 'e' },
].map((r) => ({ ...r, classification: classify(observed, r) }));

const rollup = summarise(rows);
const nike = rollup.find((b) => b.brand === 'Nike');

check('every identified sale counts — nothing is filtered by a verdict',
  [nike.soldCount, nike.rejectedCount], [3, 0]);
check('median is the real median of what sold', nike.medianPrice, 180);
check('tier is observed, which Wheelhouse files as unsorted', nike.tier, 'observed');
check('no look-for text is invented for it', nike.lookFor, null);
check('unidentified listings never reach the rollup',
  rollup.map((b) => b.brand).sort(), ['New Balance', 'Nike']);

/* ----------------------------------------------------------------- discovery
 *
 * The fallback for result pages that offer no Brand facet at all.
 */
console.log('\ndiscovery, for pages with no facet');

const candidates = discoverCandidates([
  { title: 'Oliberte Mens Leather Boots 10 Brown', priceValue: 68 },
  { title: 'Oliberte Womens Ankle Boot 8 Tan', priceValue: 74 },
  { title: 'Oliberte Mens Chukka 11 Black Leather', priceValue: 59 },
  { title: 'Faded Glory Mens Shoes 10', priceValue: 41 },
], { minCount: 3 });

check('a name selling repeatedly surfaces', candidates.some((c) => c.name === 'oliberte'), true);
check('a one-off does not', candidates.some((c) => c.name.startsWith('faded')), false);

/* ------------------------------------------------------- supplied catalog path
 *
 * Nothing ships a catalog, but the code path survives for a hand-built seed list, so
 * it stays covered. A fixture, deliberately — not a file on disk.
 */
console.log('\nsupplied catalog (retained path, nothing ships one)');

const seeded = buildIndex([{
  scope: 'fixture',
  master: [{ name: 'Alden', aliases: ['alden'] }],
  exceptions: [{
    name: 'Nike',
    aliases: ['nike'],
    models: ['sb dunk'],
    signals: [],
    rule: 'SB Dunk only',
  }],
}]);

check('a master brand still passes on the label alone',
  classify(seeded, { title: 'Alden 990 Cordovan Mens 10D' }).verdict, 'worthy');
check('an exception still requires its model',
  classify(seeded, { title: 'Nike Revolution 6 Mens 10' }).verdict, 'model-missing');
check('and passes with it',
  classify(seeded, { title: 'Nike SB Dunk Low Mens 10' }).verdict, 'worthy');
check('carrying the rule through for Wheelhouse to store',
  classify(seeded, { title: 'Nike SB Dunk Low Mens 10' }).rule, 'SB Dunk only');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks pass');
process.exit(failed ? 1 : 0);
