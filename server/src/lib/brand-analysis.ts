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
import { normaliseBrand, resolveTier } from './brands.js';
import { nowIso } from './crud.js';
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

    /* Do not touch: an explicit pin, a tier a human set, or one the AI set. The scorer
       is the fallback for when the AI is unavailable — it fills gaps rather than
       arbitrating, because it cannot read a model out of a title and the AI can. */
    const locked =
      brand.locked === 1 || brand.tier_source === 'manual' || brand.tier_source === 'ai';

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
export function mergeVerdicts(verdicts: AiVerdictInput[]): AiVerdictInput[] {
  const bySlug = new Map<string, AiVerdictInput & { modelSet: Set<string> }>();

  for (const verdict of verdicts) {
    const slug = normaliseBrand(verdict.name);
    if (!slug) continue;

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { ...verdict, modelSet: new Set(verdict.models) });
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
  }

  return [...bySlug.values()].map(({ modelSet, ...rest }) => ({
    ...rest,
    models: [...modelSet].filter((m) => m.length >= 2).slice(0, 20),
  }));
}

export function applyAiVerdicts(
  incoming: AiVerdictInput[],
): { applied: number; skipped: number; created: number; models: number } {
  const verdicts = mergeVerdicts(incoming);
  const at = nowIso();
  const select = db.prepare('SELECT id, tier_source, locked FROM ebay_brands WHERE slug = ?');
  const insert = db.prepare(
    `INSERT INTO ebay_brands (slug, name, tier, tier_source, look_for, first_seen, last_seen)
     VALUES (@slug, @name, @tier, 'ai', @look_for, @at, @at)`,
  );
  const update = db.prepare(
    `UPDATE ebay_brands
        SET tier = @tier, look_for = @look_for, tier_source = 'ai', last_seen = @at
      WHERE id = @id AND tier_source NOT IN ('manual') AND locked = 0`,
  );

  /* The models the AI judged worth picking up, stored as rows rather than only as text.
     Rows are what the brand book can strike through one at a time when a model turns out
     to be worthless — the text line cannot be corrected that finely.

     verdict_source 'ai' so a hand-set verdict is recognisable and never overwritten. */
  const upsertModel = db.prepare(
    `INSERT INTO ebay_brand_models (brand_id, slug, name, verdict, verdict_source, first_seen, last_seen)
     VALUES (@brand_id, @slug, @name, 'worthy', 'ai', @at, @at)
     ON CONFLICT(brand_id, slug) DO UPDATE
       SET name = excluded.name, last_seen = excluded.last_seen
       WHERE ebay_brand_models.verdict_source <> 'manual'`,
  );

  let applied = 0;
  let skipped = 0;
  let created = 0;
  let modelsWritten = 0;

  const writeModels = (brandId: number, names: string[]) => {
    for (const name of names) {
      const modelSlug = normaliseBrand(name);
      if (!modelSlug) continue;
      upsertModel.run({ brand_id: brandId, slug: modelSlug, name, at });
      modelsWritten += 1;
    }
  };

  db.transaction(() => {
    for (const verdict of verdicts) {
      const slug = normaliseBrand(verdict.name);
      if (!slug) { skipped += 1; continue; }

      // The same rule every other door enforces: no description, no common.
      const resolved = resolveTier(verdict.tier, verdict.lookFor);

      const existing = select.get(slug) as
        | { id: number; tier_source: string; locked: number }
        | undefined;

      if (!existing) {
        insert.run({ slug, name: verdict.name, tier: resolved.tier, look_for: resolved.look_for, at });
        const id = (db.prepare('SELECT id FROM ebay_brands WHERE slug = ?').get(slug) as { id: number }).id;
        if (resolved.tier === 'common') writeModels(id, verdict.models);
        created += 1;
        applied += 1;
        continue;
      }

      if (existing.locked === 1 || existing.tier_source === 'manual') { skipped += 1; continue; }
      const info = update.run({ id: existing.id, tier: resolved.tier, look_for: resolved.look_for, at });
      if (info.changes) {
        if (resolved.tier === 'common') writeModels(existing.id, verdict.models);
        applied += 1;
      } else skipped += 1;
    }
  })();

  return { applied, skipped, created, models: modelsWritten };
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
      WHERE id = @id AND tier_source NOT IN ('manual', 'ai') AND locked = 0`,
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
