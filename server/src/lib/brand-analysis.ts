/**
 * Turn imported sold listings into a proposed tier for every brand in the book.
 *
 * The chain, and why each link is where it is:
 *
 *   ebay_listings  ->  the only place real per-listing prices live. The brand rollup
 *                      cannot be used: it carries a median per brand, and no quartile
 *                      can be recovered from a median.
 *   attribution    ->  match each title to a known brand, longest name first so
 *                      "Polo Ralph Lauren" is never swallowed by "Ralph Lauren".
 *   scoreBrand     ->  rank statistics only. See brand-strength.ts.
 *   mineModels     ->  for the brands whose value sits in a tail, what that tail is.
 *
 * Nothing here writes a tier on its own authority. It produces PROPOSALS, and a brand a
 * human has already judged is never proposed against — tier_source = 'manual' is the
 * record of a decision, and an import that overrules it would make every correction
 * last exactly until the next scan.
 */
import { db } from './db.js';
import { normaliseBrand } from './brands.js';
import { scoreBrand, type BrandStats } from './brand-strength.js';
import { lookForFromModels, mineModels, type MinedModel } from './model-mining.js';

interface ListingRow {
  title: string;
  sold_price: number | null;
}

interface BrandRow {
  id: number;
  name: string;
  slug: string;
  tier: string;
  tier_source: string;
  look_for: string | null;
  locked: number;
}

const BRAND_COLUMNS = 'id, name, slug, tier, tier_source, look_for, locked';

export interface BrandProposal {
  brandId: number;
  name: string;
  currentTier: string;
  proposedTier: 'rare' | 'common' | 'unsorted';
  /** True when the proposal differs from what the book currently says. */
  changed: boolean;
  /** Set when the brand is locked by a human decision, and why it was left alone. */
  locked: boolean;
  stats: BrandStats;
  models: MinedModel[];
  lookFor: string | null;
}

/**
 * Word-boundary match of a brand's name inside a listing title.
 *
 * Both sides run through the same normaliser the slug uses, so "Dr. Martens" matches
 * "Dr Martens" and "Church's" matches "Churchs" without a special case for either.
 */
function titleMatcher(brands: BrandRow[]): (title: string) => BrandRow | null {
  const prepared = brands
    .map((brand) => ({ brand, words: normaliseBrand(brand.name).split(' ').filter(Boolean) }))
    .filter((entry) => entry.words.length > 0)
    // Longest first: the most specific brand name that fits should win.
    .sort((a, b) => b.words.length - a.words.length);

  return (title: string) => {
    const words = normaliseBrand(title).split(' ').filter(Boolean);
    for (const { brand, words: needle } of prepared) {
      for (let i = 0; i + needle.length <= words.length; i += 1) {
        let hit = true;
        for (let k = 0; k < needle.length; k += 1) {
          if (words[i + k] !== needle[k]) { hit = false; break; }
        }
        if (hit) return brand;
      }
    }
    return null;
  };
}

/**
 * Group every imported listing under the brand it belongs to.
 *
 * Exported because the grouping is worth inspecting on its own — a brand scoring badly
 * because attribution missed half its listings looks identical, from the outside, to a
 * brand that genuinely does not sell.
 */
export function listingsByBrand(): Map<number, ListingRow[]> {
  const brands = db
    .prepare(`SELECT ${BRAND_COLUMNS} FROM ebay_brands`)
    .all() as BrandRow[];
  const listings = db
    .prepare('SELECT title, sold_price FROM ebay_listings WHERE sold_price IS NOT NULL')
    .all() as ListingRow[];

  const match = titleMatcher(brands);
  const grouped = new Map<number, ListingRow[]>();
  for (const listing of listings) {
    const brand = match(listing.title);
    if (!brand) continue;
    const list = grouped.get(brand.id) ?? [];
    list.push(listing);
    grouped.set(brand.id, list);
  }
  return grouped;
}

/**
 * Score every brand in the book against its own sales.
 *
 * A `weak` brand proposes `unsorted` rather than deletion. Deleting on evidence would be
 * the one irreversible act in a system built to be corrected, and a brand that sells
 * badly in one category may be the reason someone looks twice in another.
 */
export function analyseBrands(): BrandProposal[] {
  const brands = db
    .prepare(`SELECT ${BRAND_COLUMNS} FROM ebay_brands ORDER BY name COLLATE NOCASE`)
    .all() as BrandRow[];
  const grouped = listingsByBrand();

  return brands.map((brand) => {
    const listings = grouped.get(brand.id) ?? [];
    const stats = scoreBrand(listings.map((l) => l.sold_price as number));

    let models: MinedModel[] = [];
    let lookFor: string | null = null;
    let proposedTier: BrandProposal['proposedTier'] = 'unsorted';

    if (stats.strength === 'rare') {
      proposedTier = 'rare';
    } else if (stats.strength === 'common') {
      models = mineModels(listings, brand.name);
      lookFor = lookForFromModels(models);
      // THE RULE, applied at the point of proposal: a common brand nobody can describe
      // is not a common brand, it is an open question. Leave it unsorted.
      proposedTier = lookFor ? 'common' : 'unsorted';
    }

    // Either an explicit pin or a tier a human already set. Both mean: do not touch.
    const locked = brand.locked === 1 || brand.tier_source === 'manual';

    return {
      brandId: brand.id,
      name: brand.name,
      currentTier: brand.tier,
      proposedTier,
      changed: proposedTier !== brand.tier,
      locked,
      stats,
      models,
      lookFor,
    };
  });
}

/**
 * Apply the proposals that are safe to apply without asking.
 *
 * Safe means: the brand carries no human decision, and the proposal does not create a
 * common brand with nothing to look for. Everything else is returned for a person to
 * confirm — which is the same division of labour the rest of the book uses.
 */
export function applyProposals(proposals: BrandProposal[]): { applied: number; skipped: number } {
  const update = db.prepare(
    `UPDATE ebay_brands
        SET tier = @tier,
            look_for = @look_for,
            tier_source = 'evidence'
      WHERE id = @id AND tier_source <> 'manual' AND locked = 0`,
  );

  let applied = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const proposal of proposals) {
      if (proposal.locked || !proposal.changed) { skipped += 1; continue; }
      if (proposal.proposedTier === 'common' && !proposal.lookFor) { skipped += 1; continue; }
      const info = update.run({
        id: proposal.brandId,
        tier: proposal.proposedTier,
        // Rare carries no qualification; unsorted keeps whatever was mined for later.
        look_for: proposal.proposedTier === 'rare' ? null : proposal.lookFor,
      });
      if (info.changes) applied += 1;
      else skipped += 1;
    }
  })();

  return { applied, skipped };
}
