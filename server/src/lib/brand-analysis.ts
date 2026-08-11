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
import { MAX_PRICE_SAMPLES, median, normaliseBrand, resolveTier } from './brands.js';
import { nowIso } from './crud.js';
import { scoreBrand, type BrandStats } from './brand-strength.js';
import { lookForFromModels, mineModels, type MinedModel } from './model-mining.js';
import type { BrandReading } from './brand-paste.js';

interface ListingRow {
  id: number;
  title: string;
  sold_price: number | null;
  brand_id: number | null;
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
  proposedTier: 'rare' | 'common' | 'unsorted' | 'not_worthy';
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
function titleMatcher<T extends { name: string }>(entries: T[]): (title: string) => T | null {
  const prepared = entries
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
export function listingsByBrand(categoryId?: number): Map<number, ListingRow[]> {
  const scope = categoryId ? ' WHERE category_id = ?' : '';
  const args = categoryId ? [categoryId] : [];

  const brands = db
    .prepare(`SELECT ${BRAND_COLUMNS} FROM ebay_brands${scope}`)
    .all(...args) as BrandRow[];
  const listings = db
    .prepare(
      `SELECT id, title, sold_price, brand_id FROM ebay_listings
        WHERE sold_price IS NOT NULL${categoryId ? ' AND category_id = ?' : ''}`,
    )
    .all(...args) as ListingRow[];

  /* Two sources, in this order of trust:
   *
   *   brand_id     what this listing was identified as, stored by the last attribution
   *                pass or by a paste that named it directly. Exact.
   *   title match  the fallback, for listings imported since that pass ran. It guesses from
   *                words in a title, which is why it is only consulted second.
   *
   * The fallback also covers a stored brand_id pointing at a brand that has since been
   * deleted: without it those sales would vanish from every figure in the book until
   * something happened to re-attribute them. */
  const known = new Set(brands.map((b) => b.id));
  const match = titleMatcher(brands);
  const grouped = new Map<number, ListingRow[]>();

  for (const listing of listings) {
    const brandId =
      listing.brand_id !== null && known.has(listing.brand_id)
        ? listing.brand_id
        : (match(listing.title)?.id ?? null);
    if (brandId === null) continue;
    const list = grouped.get(brandId) ?? [];
    list.push(listing);
    grouped.set(brandId, list);
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
export function analyseBrands(categoryId?: number): BrandProposal[] {
  const brands = db
    .prepare(
      `SELECT ${BRAND_COLUMNS} FROM ebay_brands
        ${categoryId ? 'WHERE category_id = ?' : ''} ORDER BY name COLLATE NOCASE`,
    )
    .all(...(categoryId ? [categoryId] : [])) as BrandRow[];
  const grouped = listingsByBrand(categoryId);

  return brands.map((brand) => {
    const listings = grouped.get(brand.id) ?? [];
    const stats = scoreBrand(listings.map((l) => l.sold_price as number));

    let models: MinedModel[] = [];
    let lookFor: string | null = null;
    let proposedTier: BrandProposal['proposedTier'] = 'unsorted';

    if (stats.strength === 'rare') {
      proposedTier = 'rare';
    } else if (stats.strength === 'weak') {
      // A finding, not a gap. 'unsorted' would claim nobody had looked.
      proposedTier = 'not_worthy';
    } else if (stats.strength === 'common') {
      models = mineModels(listings, brand.name);
      lookFor = lookForFromModels(models);
      // THE RULE, applied at the point of proposal: a common brand nobody can describe
      // is not a common brand, it is an open question. Leave it unsorted.
      proposedTier = lookFor ? 'common' : 'unsorted';
    }

    /* Every brand already in the book is locked against automatic change, whatever set its
       tier. Once a brand exists, moving it between tiers is the user's decision — so this
       is now always true, and it stays in the shape of a condition because the UI reads it
       to explain WHY a proposal was not applied. */
    const locked = true;

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

/* THERE IS NO LONGER A VERDICT MERGER HERE, and that is a deletion worth explaining.
 *
 * `mergeVerdicts` collapsed rows the classifier returned twice and folded "Brooks Ghost Max"
 * into "Brooks" on the theory that a slug beginning with another slug is a model wearing a
 * brand's name. Both rules were defences against a small model, and both are wrong now that
 * a person writes the input: two rows for one brand is a contradiction its author should be
 * told about rather than have silently averaged, and "Nike Golf" beside "Nike" is a
 * deliberate second row, not a mistake to absorb.
 *
 * Slug-level duplicates are still caught — in parseBrandPaste, where there is somewhere to
 * report them. See brand-paste.ts.
 */

/**
 * Recompute every brand's sales figures from the listings themselves.
 *
 * These numbers used to arrive from outside, alongside brands that were not brands. With
 * that door closed they have to be derived, and deriving them is the better answer
 * anyway: the listings are the evidence, so a count that disagrees with them was wrong.
 *
 * Recomputed rather than accumulated, which matters after a re-run — adding to the old
 * total would double every brand each time the book was rebuilt. A brand no listing
 * matches is zeroed rather than left holding a stale figure; the AI names brands it knows
 * from the resale market, and some of those legitimately have no sale in this scan.
 */
export function refreshBrandStats(categoryId?: number): number {
  const grouped = listingsByBrand(categoryId);
  const update = db.prepare(
    `UPDATE ebay_brands
        SET sold_count = @sold_count, median_price = @median_price,
            high_price = @high_price, price_samples = @price_samples
      WHERE id = @id`,
  );

  /* A model's figures come only from listings that were attributed to it — no title-match
     fallback, unlike the brand above. A brand can be guessed from a title with reasonable
     odds; a model cannot, and a median built from guesses would be worse than no median,
     because it would look exactly as authoritative as a real one. */
  const updateModel = db.prepare(
    `UPDATE ebay_brand_models
        SET sold_count = @sold_count, median_price = @median_price,
            high_price = @high_price, price_samples = @price_samples
      WHERE id = @id`,
  );

  let touched = 0;
  db.transaction(() => {
    const scope = categoryId ? ' WHERE category_id = ?' : '';
    const args = categoryId ? [categoryId] : [];
    const brands = db
      .prepare(`SELECT id FROM ebay_brands${scope}`)
      .all(...args) as Array<{ id: number }>;

    for (const brand of brands) {
      const prices = (grouped.get(brand.id) ?? [])
        .map((l) => l.sold_price)
        .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
      update.run({
        id: brand.id,
        sold_count: prices.length,
        median_price: median(prices),
        high_price: prices.length ? Math.max(...prices) : null,
        price_samples: JSON.stringify(prices.slice(-MAX_PRICE_SAMPLES)),
      });
      touched += 1;
    }

    const modelPrices = db
      .prepare(
        `SELECT m.id, l.sold_price
           FROM ebay_brand_models m
           JOIN ebay_brands b ON b.id = m.brand_id
           LEFT JOIN ebay_listings l
             ON l.model_id = m.id AND l.sold_price IS NOT NULL
          ${categoryId ? 'WHERE b.category_id = ?' : ''}`,
      )
      .all(...args) as Array<{ id: number; sold_price: number | null }>;

    const byModel = new Map<number, number[]>();
    for (const row of modelPrices) {
      const list = byModel.get(row.id) ?? [];
      if (typeof row.sold_price === 'number' && Number.isFinite(row.sold_price)) {
        list.push(row.sold_price);
      }
      byModel.set(row.id, list);
    }

    for (const [id, prices] of byModel) {
      updateModel.run({
        id,
        sold_count: prices.length,
        median_price: median(prices),
        high_price: prices.length ? Math.max(...prices) : null,
        price_samples: JSON.stringify(prices.slice(-MAX_PRICE_SAMPLES)),
      });
    }
  })();
  return touched;
}

/**
 * Match every listing in a category to a brand in the book, and to a model within it.
 *
 * THIS IS WHAT THE AI USED TO DO, and doing it with string matching instead is the whole
 * bet of the change. The old path asked a model what each numbered listing WAS and stored
 * the answer; a paste can carry those same answers in its `items` half, but only if it was
 * produced against a freshly printed prompt. This runs afterwards either way, so a paste of
 * bare brand names still ends up with sold counts, medians and per-model figures rather
 * than a book full of zeroes.
 *
 * The two halves are matched differently on purpose:
 *
 *   brand   any listing whose title contains the brand's name, longest name first, so
 *           "Polo Ralph Lauren" is never swallowed by "Ralph Lauren".
 *   model   only within the brand the listing was already attributed to. "1460" in a title
 *           means the Dr. Martens 1460 when the listing is a Dr. Martens; free of that
 *           scope it is a number that means nothing.
 *
 * Anything already attributed is left alone unless what it points at has gone — a brand
 * deleted from the book leaves listings aimed at nothing, and re-matching them is the only
 * way those sales ever count again.
 *
 * Returns how many listings carry a brand when it finishes, which is the figure worth
 * reporting: "how much of this category is identified", not "how much did I just change".
 */
export function attributeListings(categoryId: number): number {
  const brands = db
    .prepare(`SELECT ${BRAND_COLUMNS} FROM ebay_brands WHERE category_id = ?`)
    .all(categoryId) as BrandRow[];
  if (!brands.length) return 0;

  const matchBrand = titleMatcher(brands);

  const modelRows = db
    .prepare(
      `SELECT m.id, m.name, m.brand_id FROM ebay_brand_models m
         JOIN ebay_brands b ON b.id = m.brand_id
        WHERE b.category_id = ?`,
    )
    .all(categoryId) as Array<{ id: number; name: string; brand_id: number }>;

  const modelsOf = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of modelRows) {
    modelsOf.set(row.brand_id, [...(modelsOf.get(row.brand_id) ?? []), { id: row.id, name: row.name }]);
  }
  // Built once per brand rather than per listing — a category with a few thousand sales
  // would otherwise rebuild the same matcher a few thousand times.
  const matchModel = new Map<number, ReturnType<typeof titleMatcher<{ id: number; name: string }>>>();
  for (const [brandId, list] of modelsOf) matchModel.set(brandId, titleMatcher(list));

  const listings = db
    .prepare('SELECT id, title, brand_id, model_id FROM ebay_listings WHERE category_id = ?')
    .all(categoryId) as Array<{ id: number; title: string; brand_id: number | null; model_id: number | null }>;

  const known = new Set(brands.map((b) => b.id));
  const link = db.prepare(
    'UPDATE ebay_listings SET brand_id = @brand_id, model_id = @model_id WHERE id = @id',
  );

  let attributed = 0;

  db.transaction(() => {
    for (const listing of listings) {
      const brandId =
        listing.brand_id !== null && known.has(listing.brand_id)
          ? listing.brand_id
          : (matchBrand(listing.title)?.id ?? null);

      if (brandId === null) {
        // Points at a brand that no longer exists and matches nothing now. Clear it rather
        // than leave a dangling id that reads as "identified" and counts for nobody.
        if (listing.brand_id !== null) link.run({ id: listing.id, brand_id: null, model_id: null });
        continue;
      }
      attributed += 1;

      const owned = modelsOf.get(brandId) ?? [];
      const modelId =
        listing.model_id !== null && owned.some((m) => m.id === listing.model_id)
          ? listing.model_id
          : (matchModel.get(brandId)?.(listing.title)?.id ?? null);

      if (listing.brand_id === brandId && listing.model_id === modelId) continue;
      link.run({ id: listing.id, brand_id: brandId, model_id: modelId });
    }
  })();

  return attributed;
}

export interface ReadingResult {
  /** Brands that did not exist in this category and were created. */
  created: number;
  /** Brands already in the book whose tier or description the paste changed. */
  updated: number;
  /** Brands already in the book, left exactly as they were. */
  untouched: number;
  /** Brands the paste would have changed but could not, because they are pinned. */
  locked: number;
  /** Model rows added. Existing models are never rewritten. */
  models: number;
  /** Listings carrying a brand once the paste has been filed. */
  attributed: number;
}

/**
 * File a pasted reading into the book.
 *
 * The permissions, which are the point of this function:
 *
 *   brands   INSERT always; UPDATE only when the caller asks for it AND the brand is not
 *            locked. This is the one rule that changed when the classifier left. It used to
 *            be insert-only with no exception, because the thing writing was a model that
 *            had no business overruling a person. What writes now IS the person, so a
 *            correction pasted a second time has to be able to land — but it lands only on
 *            request, so the ordinary paste still cannot quietly rewrite work you did by
 *            hand, and the pin still refuses it outright either way.
 *   models   INSERT ONLY, unchanged. An existing model keeps its verdict, so a model struck
 *            through by hand stays struck through however many times it is pasted again.
 *   listings brand_id and model_id, from `items` where the paste supplied them and from
 *            title matching afterwards for the rest. Everything else about a listing was
 *            settled at import and is never revisited.
 *
 * Scoped to one category throughout. Nike under Men/Shoes and Nike under Men/Shirts are
 * different rows with different tiers, and nothing here can read across that line.
 *
 * `listingIds[i]` is the database id of the listing the reading numbered `i`.
 */
export function applyReading(
  categoryId: number,
  reading: BrandReading,
  listingIds: Array<number | undefined>,
  options: { overwrite?: boolean } = {},
): ReadingResult {
  const at = nowIso();

  const selectBrand = db.prepare(
    'SELECT id, tier, look_for, locked FROM ebay_brands WHERE category_id = ? AND slug = ?',
  );
  const insertBrand = db.prepare(
    `INSERT INTO ebay_brands (category_id, slug, name, tier, tier_source, look_for, first_seen, last_seen)
     VALUES (@category_id, @slug, @name, @tier, 'paste', @look_for, @at, @at)`,
  );
  const updateBrand = db.prepare(
    `UPDATE ebay_brands SET tier = @tier, look_for = @look_for, tier_source = 'paste',
                            last_seen = @at
      WHERE id = @id`,
  );
  // Only ever touches when-last-seen. Nothing a person decided is reachable from here.
  const touchBrand = db.prepare('UPDATE ebay_brands SET last_seen = @at WHERE id = @id');

  /* Models as rows rather than as a line of text, because rows are what the brand book can
     strike through one at a time when a model turns out to be worthless.

     DO NOTHING on conflict, not DO UPDATE: an existing model row is already correct, and
     the verdict on it may have been set by hand. */
  const insertModel = db.prepare(
    `INSERT INTO ebay_brand_models (brand_id, slug, name, verdict, verdict_source, first_seen, last_seen)
     VALUES (@brand_id, @slug, @name, 'worthy', 'paste', @at, @at)
     ON CONFLICT(brand_id, slug) DO NOTHING`,
  );
  const selectModel = db.prepare(
    'SELECT id FROM ebay_brand_models WHERE brand_id = ? AND slug = ?',
  );
  const touchModel = db.prepare('UPDATE ebay_brand_models SET last_seen = @at WHERE id = @id');
  const linkListing = db.prepare(
    'UPDATE ebay_listings SET brand_id = @brand_id, model_id = @model_id WHERE id = @id',
  );

  let created = 0;
  let updated = 0;
  let untouched = 0;
  let locked = 0;
  let models = 0;

  /** Canonical slug -> brand id, for this category only. Filled as brands are settled. */
  const brandIds = new Map<string, number>();

  const modelId = (brandId: number, name: string): number | null => {
    const slug = normaliseBrand(name);
    if (!slug) return null;
    const info = insertModel.run({ brand_id: brandId, slug, name, at });
    const row = selectModel.get(brandId, slug) as { id: number } | undefined;
    if (!row) return null;
    if (info.changes) models += 1;
    else touchModel.run({ id: row.id, at });
    return row.id;
  };

  db.transaction(() => {
    for (const verdict of reading.brands) {
      const slug = normaliseBrand(verdict.name);
      if (!slug) continue;

      // The rule every other door enforces, enforced here too: no description, no common.
      const resolved = resolveTier(verdict.tier, verdict.lookFor);
      const existing = selectBrand.get(categoryId, slug) as
        | { id: number; tier: string; look_for: string | null; locked: number }
        | undefined;

      if (!existing) {
        const info = insertBrand.run({
          category_id: categoryId,
          slug,
          name: verdict.name,
          tier: resolved.tier,
          look_for: resolved.look_for,
          at,
        });
        brandIds.set(slug, Number(info.lastInsertRowid));
        created += 1;
        continue;
      }

      brandIds.set(slug, existing.id);

      const differs =
        existing.tier !== resolved.tier || (existing.look_for ?? null) !== resolved.look_for;

      if (!options.overwrite || !differs) {
        // Present already and not being rewritten. Its tier is not this pass's business.
        touchBrand.run({ id: existing.id, at });
        untouched += 1;
        continue;
      }
      if (existing.locked === 1) {
        // The pin means "stop revising this", and a bulk paste is exactly the revision it
        // was set against. Counted so the answer can say so rather than imply it landed.
        touchBrand.run({ id: existing.id, at });
        locked += 1;
        continue;
      }

      updateBrand.run({ id: existing.id, tier: resolved.tier, look_for: resolved.look_for, at });
      updated += 1;
    }

    // Models for every brand in every tier — rare included.
    for (const verdict of reading.brands) {
      const brandId = brandIds.get(normaliseBrand(verdict.name));
      if (!brandId) continue;
      for (const name of verdict.models) modelId(brandId, name);
    }

    /* Per-listing attribution, where the paste carried it. Runs before the title matching
       below so an answer written about these exact listings wins over a guess from words. */
    for (const item of reading.items) {
      const listingId = listingIds[item.index];
      if (listingId === undefined) continue;

      const brandId = brandIds.get(normaliseBrand(item.brand));
      if (!brandId) continue;

      linkListing.run({
        id: listingId,
        brand_id: brandId,
        model_id: item.model ? modelId(brandId, item.model) : null,
      });
    }
  })();

  // Both after the rows exist, not before — a brand created in this pass has no id to
  // attribute listings to until it does, and no figures until they are attributed.
  const attributed = attributeListings(categoryId);
  refreshBrandStats(categoryId);

  return { created, updated, untouched, locked, models, attributed };
}

/**
 * What the sold prices would say, if anyone were asking them.
 *
 * THIS NO LONGER WRITES, and the empty body is the feature. The scorer used to move brands
 * between tiers on its own when the AI was unavailable, which made it the second thing —
 * beside the classifier — capable of undoing a decision the user had made. Both are now
 * out of that business: a brand's tier is set once, when the brand is first seen, and after
 * that only the user changes it.
 *
 * The proposals are still computed and still shown. `analyseBrands` is what the Brand
 * Report reads, and a suggestion nobody is obliged to take is useful — it is the same
 * arithmetic, minus the authority. Kept as a function returning zeroes rather than deleted
 * so the shape of the API does not change under the client mid-release.
 */
export function applyProposals(proposals: BrandProposal[]): { applied: number; skipped: number } {
  return { applied: 0, skipped: proposals.length };
}
