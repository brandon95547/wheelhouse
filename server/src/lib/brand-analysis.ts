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
import type { AiReading } from './brand-ai.js';

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
   *   brand_id     what the classifier decided this listing IS, stored at import. Exact.
   *   title match  the fallback, for listings imported before attribution existed or while
   *                the API was down. It guesses from words in a title, which is why it is
   *                only consulted when nothing better is on the row.
   *
   * Without the fallback a book would read as empty the moment the AI was unavailable,
   * which is the failure this whole module is built to avoid. */
  const known = new Set(brands.map((b) => b.id));
  const match = titleMatcher(brands);
  const grouped = new Map<number, ListingRow[]>();

  for (const listing of listings) {
    const brandId =
      listing.brand_id !== null && known.has(listing.brand_id)
        ? listing.brand_id
        : listing.brand_id === null
          ? (match(listing.title)?.id ?? null)
          : null;
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

/**
 * Fold DeepSeek's verdicts into the book.
 *
 * The model decides the tier because it can see what the arithmetic cannot: that a
 * brand's good sales all say "1460 Made in England" and its bad ones do not. The
 * arithmetic is still what it was shown, so the two are looking at the same evidence.
 *
 * Locked and hand-judged brands are skipped here exactly as they are in applyProposals —
 * a paid API is still not allowed to overrule a person.
 */
interface AiVerdictInput {
  name: string;
  tier: 'rare' | 'common' | 'not_worthy' | 'unsorted';
  models: string[];
  lookFor: string | null;
}

/** Strongest first. A stray second mention must not demote a brand already judged well. */
const TIER_RANK: Record<AiVerdictInput['tier'], number> = {
  rare: 4,
  common: 3,
  not_worthy: 2,
  // Lowest: "I could not tell" must never displace an actual judgement of the same brand.
  unsorted: 1,
};

/**
 * Collapse verdicts that are the same brand.
 *
 * One response can name a brand twice — "Nike" and "Nike Inc", or the same name returned
 * in two chunks of a large batch. Both normalise to one slug, so without this the second
 * silently overwrites the first and its models are lost.
 */
export function mergeVerdicts(verdicts: AiVerdictInput[]): {
  verdicts: AiVerdictInput[];
  /** Slug that was folded away -> the slug it was folded into. */
  aliasOf: Map<string, string>;
} {
  const bySlug = new Map<string, AiVerdictInput & { modelSet: Set<string> }>();
  const aliasOf = new Map<string, string>();

  for (const verdict of verdicts) {
    const slug = normaliseBrand(verdict.name);
    if (!slug) continue;

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { ...verdict, modelSet: new Set(verdict.models) });
      // Every canonical slug maps to itself, so callers need only one lookup.
      aliasOf.set(slug, slug);
      continue;
    }

    for (const model of verdict.models) existing.modelSet.add(model);
    // Keep the first usable description rather than the last, and the stronger tier.
    if (!existing.lookFor && verdict.lookFor) existing.lookFor = verdict.lookFor;
    if (TIER_RANK[verdict.tier] > TIER_RANK[existing.tier]) existing.tier = verdict.tier;
  }

  /* Fold "Brand + model" rows into the brand.
   *
   * A model returned as though it were a brand — "Brooks Ghost Max" beside "Brooks",
   * "Danner 2650" beside "Danner" — would otherwise become a second row competing with the
   * real one. When one slug begins with another at a word boundary, the longer is the
   * shorter plus a model: its models are absorbed and the row is dropped. */
  const slugs = [...bySlug.keys()].sort((a, b) => a.length - b.length);
  for (const longer of [...slugs].reverse()) {
    const parent = slugs.find((s) => s !== longer && longer.startsWith(`${s} `));
    if (!parent) continue;

    const child = bySlug.get(longer)!;
    const owner = bySlug.get(parent)!;
    // The tail of the child's name IS the model, and so is anything it listed.
    owner.modelSet.add(child.name.slice(child.name.length - (longer.length - parent.length) + 1).trim());
    for (const model of child.modelSet) owner.modelSet.add(model);
    if (!owner.lookFor && child.lookFor) owner.lookFor = child.lookFor;
    if (TIER_RANK[child.tier] > TIER_RANK[owner.tier]) owner.tier = child.tier;
    bySlug.delete(longer);

    /* Record where it went, and re-point anything already pointing at it. A three-deep
       fold ("Nike Air Jordan 1" -> "Nike Air Jordan" -> "Nike") must leave every alias
       aimed at the brand that survived, not at an intermediate row that no longer exists. */
    aliasOf.set(longer, parent);
    for (const [from, to] of aliasOf) if (to === longer) aliasOf.set(from, parent);
  }

  return {
    verdicts: [...bySlug.values()].map(({ modelSet, ...rest }) => ({
      ...rest,
      models: [...modelSet].filter((m) => m.length >= 2).slice(0, 20),
    })),
    aliasOf,
  };
}

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

export interface ReadingResult {
  /** Brands that did not exist in this category and were created. */
  created: number;
  /** Brands already in the book. Their tiers were read and discarded. */
  untouched: number;
  /** Model rows added. Existing models are never rewritten. */
  models: number;
  /** Listings given a brand, a model, or both. */
  attributed: number;
}

/**
 * File a reading into the book. THE ONLY PLACE THE CLASSIFIER MAY WRITE.
 *
 * The permissions, which are the point of this function:
 *
 *   brands   INSERT ONLY. A brand already in this category keeps the tier it has, full
 *            stop — not "unless unlocked", not "unless the AI is confident". There is no
 *            UPDATE statement here for tier or look_for, so there is no path, no flag and
 *            no future edit that quietly restores one. Moving a brand between tiers is the
 *            user's decision and the PATCH route is where it happens.
 *   models   INSERT ONLY. A new model under a known brand is a new fact, and facts are
 *            what the classifier is trusted with. An existing model keeps its verdict, so
 *            a model struck through by hand stays struck through.
 *   listings brand_id and model_id, set once. Everything else about a listing was settled
 *            at import and is never revisited.
 *
 * Scoped to one category throughout. Nike under Men/Shoes and Nike under Men/Shirts are
 * different rows with different tiers, and nothing here can read across that line.
 *
 * `listingIds[i]` is the database id of the listing the reading numbered `i`.
 */
export function applyReading(
  categoryId: number,
  reading: AiReading,
  listingIds: Array<number | undefined>,
): ReadingResult {
  const { verdicts, aliasOf } = mergeVerdicts(
    reading.brands.map((b) => ({ name: b.name, tier: b.tier, models: b.models, lookFor: b.lookFor })),
  );
  const at = nowIso();

  const selectBrand = db.prepare(
    'SELECT id FROM ebay_brands WHERE category_id = ? AND slug = ?',
  );
  const insertBrand = db.prepare(
    `INSERT INTO ebay_brands (category_id, slug, name, tier, tier_source, look_for, first_seen, last_seen)
     VALUES (@category_id, @slug, @name, @tier, 'ai', @look_for, @at, @at)`,
  );
  // Only ever touches when-last-seen. Nothing a person decided is reachable from here.
  const touchBrand = db.prepare('UPDATE ebay_brands SET last_seen = @at WHERE id = @id');

  /* Models as rows rather than as a line of text, because rows are what the brand book can
     strike through one at a time when a model turns out to be worthless.

     DO NOTHING on conflict, not DO UPDATE: an existing model row is already correct, and
     the verdict on it may have been set by hand. */
  const insertModel = db.prepare(
    `INSERT INTO ebay_brand_models (brand_id, slug, name, verdict, verdict_source, first_seen, last_seen)
     VALUES (@brand_id, @slug, @name, 'worthy', 'ai', @at, @at)
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
  let untouched = 0;
  let models = 0;
  let attributed = 0;

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
    for (const verdict of verdicts) {
      const slug = normaliseBrand(verdict.name);
      if (!slug) continue;

      const existing = selectBrand.get(categoryId, slug) as { id: number } | undefined;
      if (existing) {
        // Present already. Its tier is not this function's business.
        touchBrand.run({ id: existing.id, at });
        brandIds.set(slug, existing.id);
        untouched += 1;
        continue;
      }

      // New to this category, so the classifier's tier is the only one available. The same
      // rule every other door enforces still applies: no description, no common.
      const resolved = resolveTier(verdict.tier, verdict.lookFor);
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
    }

    // Models for every brand in every tier — rare included, which is the change.
    for (const verdict of verdicts) {
      const brandId = brandIds.get(normaliseBrand(verdict.name));
      if (!brandId) continue;
      for (const name of verdict.models) modelId(brandId, name);
    }

    /* Attribution last, once every brand named in this reading has an id. */
    for (const item of reading.items) {
      const listingId = listingIds[item.index];
      if (listingId === undefined) continue;

      const raw = normaliseBrand(item.brand);
      const brandId = brandIds.get(aliasOf.get(raw) ?? raw);
      if (!brandId) continue;

      linkListing.run({
        id: listingId,
        brand_id: brandId,
        model_id: item.model ? modelId(brandId, item.model) : null,
      });
      attributed += 1;
    }
  })();

  // After the rows exist, not before — a brand created in this pass has no id to attribute
  // listings to until it does.
  refreshBrandStats(categoryId);

  return { created, untouched, models, attributed };
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
