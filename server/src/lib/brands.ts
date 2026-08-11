/**
 * The brand book: what to look for, and which models within a common brand are worth it.
 *
 * Two tiers, and the line between them is about WHERE THE PICKUP SIGNAL LIVES:
 *
 *   rare    the brand itself is the signal. Seeing the label is reason enough to pick
 *           the item up — Alden, Grant Stone, Viberg. Nothing else needs to be true.
 *   common  the specific model is the signal. The label is everywhere and worthless by
 *           default; only certain models, lines, materials, vintages, collaborations or
 *           limited editions pay — Nike, Adidas, New Balance.
 *
 * and `unsorted` for anything an import turned up that no guide has judged yet.
 *
 * RARE IS NOT A COMPLIMENT. It does not mean expensive, famous, or capable of having
 * valuable models. If only certain models of a brand are worth buying, that brand is
 * common no matter how prestigious the name.
 *
 * THEREFORE: A COMMON BRAND WITHOUT A `look_for` IS A BUG, NOT A ROW. A common brand
 * that cannot say what to look for is indistinguishable from a famous name, and telling
 * someone "Nike" while they stand in a thrift store is worse than telling them nothing —
 * it reads as an endorsement of every Nike on the rack. So the tier and the description
 * are a single fact, enforced together at every door into the table: import, PATCH, and
 * the two helpers below. A brand that would be common but has no description is filed
 * `unsorted` instead, where it reads as a question rather than an answer.
 *
 * THE RULE THAT MAKES THIS MORE THAN A LIST. Nike Jordan is worth picking up, but Nike
 * made Jordan models that are not, so a verdict on the BRAND cannot express the truth.
 * Models therefore carry their own verdict, and an exclusion beats the inclusion it sits
 * inside: "jordan delta" marked not-worthy overrides the broader "jordan" that matches
 * it. That is what lets the book get sharper as it is used, instead of only when someone
 * rewrites the guide.
 */
import { db } from './db.js';

export type Tier = 'rare' | 'common' | 'unsorted' | 'not_worthy';
export type Verdict = 'worthy' | 'not_worthy';

export const TIERS: Tier[] = ['rare', 'common', 'unsorted', 'not_worthy'];
export const VERDICTS: Verdict[] = ['worthy', 'not_worthy'];

/** How many observed prices a row keeps. Enough for a stable median, bounded so a
 *  brand with ten thousand sales does not grow without limit. */
export const MAX_PRICE_SAMPLES = 500;

/**
 * The dedupe key. Must stay in step with `normalise` in the Lookout extension
 * (lib/classify.js) — if these two ever disagree, the same brand arrives under two
 * slugs and the book quietly grows duplicates, which is the one thing the user asked
 * it not to do.
 */
export function normaliseBrand(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // Zegna's accents, Enzo Bonafè's grave
    .replace(/['’`]/g, '')             // Church's -> churchs
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    /* Join runs of single letters, so an initialism written either way lands on one
       slug: "L.L. Bean" and "LL Bean" both become "ll bean", "A. Testoni" and
       "A Testoni" both become "atestoni". Without this the book grows a second row for
       every brand whose punctuation a seller omitted. */
    .replace(/\b(?:[a-z0-9] )+[a-z0-9]\b/g, (run) => run.replace(/ /g, ''));
}

/** The extension speaks master/exception; the book speaks rare/common. */
export function tierFromClassifier(tier: unknown): Tier {
  const value = String(tier ?? '').toLowerCase();
  if (value === 'master' || value === 'rare') return 'rare';
  if (value === 'exception' || value === 'common') return 'common';
  return 'unsorted';
}

/** The longest a "look for" line can be and still be read at a glance in an aisle. */
const MAX_LOOK_FOR = 400;

/**
 * A description is only a description if it actually names something to look for.
 * Whitespace, an empty string and a stray "-" are all the same as saying nothing.
 */
export function cleanLookFor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length < 3) return null;
  return text.slice(0, MAX_LOOK_FOR);
}

/**
 * The single place the core rule is decided: common needs a description, rare must not
 * be given one, and anything else falls to unsorted.
 *
 * Returns the tier the row may actually hold, given the description available to it.
 * Callers pass whatever description they have — from the import, from the request body,
 * or already on the row — and get back a pair that cannot violate the rule.
 */
export function resolveTier(tier: Tier, lookFor: unknown): { tier: Tier; look_for: string | null } {
  const description = cleanLookFor(lookFor);

  // Rare says the brand alone is the signal, so a model qualification would contradict
  // the tier. Drop it rather than store a fact the tier denies.
  if (tier === 'rare') return { tier: 'rare', look_for: null };

  // Not worthy is a finding, not a gap: the sales were examined and neither the brand nor
  // any model in it earned a pickup. It keeps whatever was learned, so a later scan that
  // changes the picture starts from something rather than nothing.
  if (tier === 'not_worthy') return { tier: 'not_worthy', look_for: description };

  // The rule, in one line: no description, no common.
  if (tier === 'common') {
    return description
      ? { tier: 'common', look_for: description }
      : { tier: 'unsorted', look_for: null };
  }

  // Unsorted may carry a description it arrived with — it is what the brand needs to be
  // promoted to common later, and throwing it away would make that promotion harder.
  return { tier: 'unsorted', look_for: description };
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 100) / 100;
}

export interface BrandRow {
  id: number;
  slug: string;
  name: string;
  tier: Tier;
  tier_source: string;
  look_for: string | null;
  kind: string | null;
  sold_count: number;
  rejected_count: number;
  median_price: number | null;
  high_price: number | null;
  notes: string | null;
  first_seen: string;
  last_seen: string;
  models: Array<{
    id: number;
    slug: string;
    name: string;
    verdict: Verdict;
    verdict_source: string;
    sold_count: number;
    median_price: number | null;
    high_price: number | null;
    notes: string | null;
  }>;
}

/**
 * The whole book, alphabetical, with each brand's models attached.
 *
 * Alphabetical rather than by value on purpose: this is a reference you consult while
 * holding a shoe, and the only order that helps then is the one your eye can scan.
 * Within a brand, models lead with the exclusions — those are the surprising ones, and
 * the reason to look at a common brand at all.
 */
export function listBrands(filter?: { tier?: string; search?: string }): BrandRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.tier && filter.tier !== 'all') {
    clauses.push('tier = ?');
    params.push(filter.tier);
  }
  if (filter?.search) {
    clauses.push('name LIKE ? ESCAPE \'\\\'');
    params.push(`%${filter.search.replace(/[%_]/g, (m) => `\\${m}`)}%`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

  const brands = db
    .prepare(`SELECT * FROM ebay_brands${where} ORDER BY name COLLATE NOCASE ASC`)
    .all(...params) as BrandRow[];

  const models = db
    .prepare(
      `SELECT * FROM ebay_brand_models
        ORDER BY verdict = 'worthy' ASC, sold_count DESC, name COLLATE NOCASE ASC`,
    )
    .all() as Array<BrandRow['models'][number] & { brand_id: number }>;

  const byBrand = new Map<number, BrandRow['models']>();
  for (const model of models) {
    const list = byBrand.get(model.brand_id) ?? [];
    list.push(model);
    byBrand.set(model.brand_id, list);
  }

  return brands.map((brand) => ({ ...brand, models: byBrand.get(brand.id) ?? [] }));
}
