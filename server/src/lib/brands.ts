/**
 * The brand book: what to look for, and which models within a common brand are worth it.
 *
 * Two tiers, in the language of the trade:
 *
 *   rare    the label alone is reason to inspect — Alden, Grant Stone
 *   common  the label is everywhere; only certain models carry value — Nike, Adidas
 *
 * and `unsorted` for anything an import turned up that no guide has judged yet.
 *
 * THE RULE THAT MAKES THIS MORE THAN A LIST. Nike Jordan is worth picking up, but Nike
 * made Jordan models that are not, so a verdict on the BRAND cannot express the truth.
 * Models therefore carry their own verdict, and an exclusion beats the inclusion it sits
 * inside: "jordan delta" marked not-worthy overrides the broader "jordan" that matches
 * it. That is what lets the book get sharper as it is used, instead of only when someone
 * rewrites the guide.
 */
import { db } from './db.js';
import { nowIso } from './crud.js';

export type Tier = 'rare' | 'common' | 'unsorted';
export type Verdict = 'worthy' | 'not_worthy';

export const TIERS: Tier[] = ['rare', 'common', 'unsorted'];
export const VERDICTS: Verdict[] = ['worthy', 'not_worthy'];

/** How many observed prices a row keeps. Enough for a stable median, bounded so a
 *  brand with ten thousand sales does not grow without limit. */
const MAX_PRICE_SAMPLES = 500;

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
    .trim();
}

/** The extension speaks master/exception; the book speaks rare/common. */
export function tierFromClassifier(tier: unknown): Tier {
  const value = String(tier ?? '').toLowerCase();
  if (value === 'master' || value === 'rare') return 'rare';
  if (value === 'exception' || value === 'common') return 'common';
  return 'unsorted';
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 100) / 100;
}

function readSamples(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

/** Keep the most recent observations; they describe the market as it is now. */
function mergeSamples(existing: number[], incoming: number[]): number[] {
  return [...existing, ...incoming].slice(-MAX_PRICE_SAMPLES);
}

interface IncomingModel {
  name?: unknown;
  count?: unknown;
  medianPrice?: unknown;
  highPrice?: unknown;
}

export interface IncomingBrand {
  brand?: unknown;
  name?: unknown;
  tier?: unknown;
  kind?: unknown;
  soldCount?: unknown;
  rejectedCount?: unknown;
  medianPrice?: unknown;
  highPrice?: unknown;
  models?: unknown;
  examples?: unknown;
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const int = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * Fold one scan's brands into the book.
 *
 * A brand already in the book keeps its tier. That is deliberate: the tier is a
 * judgement, and once a human has made it — or corrected one — a later import must not
 * silently overwrite it. Only a brand the book has never seen takes the tier the
 * classifier suggests.
 */
export function upsertBrands(incoming: IncomingBrand[]): {
  created: number;
  updated: number;
  models: number;
} {
  const at = nowIso();
  let created = 0;
  let updated = 0;
  let modelsTouched = 0;

  const selectBrand = db.prepare('SELECT * FROM ebay_brands WHERE slug = ?');
  const insertBrand = db.prepare(
    `INSERT INTO ebay_brands
       (slug, name, tier, tier_source, kind, sold_count, rejected_count,
        median_price, high_price, price_samples, first_seen, last_seen)
     VALUES (@slug, @name, @tier, @tier_source, @kind, @sold_count, @rejected_count,
             @median_price, @high_price, @price_samples, @at, @at)`,
  );
  // The display name is NOT updated. The slug already guarantees one row per brand, so
  // a later import differing only in case would otherwise turn "Dr. Martens" into
  // "DR MARTENS" — the book would look like it was degrading with use. First spelling
  // wins; PATCH can set a better one deliberately.
  const updateBrand = db.prepare(
    `UPDATE ebay_brands
        SET kind = COALESCE(@kind, kind),
            sold_count = sold_count + @sold_count,
            rejected_count = rejected_count + @rejected_count,
            median_price = @median_price,
            high_price = MAX(COALESCE(high_price, 0), COALESCE(@high_price, 0)),
            price_samples = @price_samples,
            last_seen = @at
      WHERE id = @id`,
  );

  const selectModel = db.prepare('SELECT * FROM ebay_brand_models WHERE brand_id = ? AND slug = ?');
  const insertModel = db.prepare(
    `INSERT INTO ebay_brand_models
       (brand_id, slug, name, verdict, verdict_source, sold_count, median_price,
        high_price, price_samples, first_seen, last_seen)
     VALUES (@brand_id, @slug, @name, 'worthy', 'guide', @sold_count, @median_price,
             @high_price, @price_samples, @at, @at)`,
  );
  const updateModel = db.prepare(
    `UPDATE ebay_brand_models
        SET sold_count = sold_count + @sold_count,
            median_price = @median_price,
            high_price = MAX(COALESCE(high_price, 0), COALESCE(@high_price, 0)),
            price_samples = @price_samples,
            last_seen = @at
      WHERE id = @id`,
  );

  db.transaction(() => {
    for (const raw of incoming) {
      const name = String(raw.brand ?? raw.name ?? '').trim();
      const slug = normaliseBrand(name);
      if (!slug) continue;

      const soldCount = int(raw.soldCount);
      const observed = num(raw.medianPrice);
      // One import contributes its median once per sale it represents, which keeps a
      // brand seen ten times weighted above one seen once.
      const samples = observed ? Array(Math.min(soldCount || 1, 50)).fill(observed) : [];

      const existing = selectBrand.get(slug) as Record<string, unknown> | undefined;

      if (!existing) {
        const merged = mergeSamples([], samples);
        insertBrand.run({
          slug,
          name,
          tier: tierFromClassifier(raw.tier),
          tier_source: raw.tier ? 'guide' : 'import',
          kind: raw.kind ? String(raw.kind) : null,
          sold_count: soldCount,
          rejected_count: int(raw.rejectedCount),
          median_price: median(merged),
          high_price: num(raw.highPrice),
          price_samples: JSON.stringify(merged),
          at,
        });
        created += 1;
      } else {
        const merged = mergeSamples(readSamples(existing.price_samples), samples);
        updateBrand.run({
          id: existing.id,
          kind: raw.kind ? String(raw.kind) : null,
          sold_count: soldCount,
          rejected_count: int(raw.rejectedCount),
          median_price: median(merged),
          high_price: num(raw.highPrice),
          price_samples: JSON.stringify(merged),
          at,
        });
        updated += 1;
      }

      const brandId = (existing?.id as number) ?? (selectBrand.get(slug) as { id: number }).id;

      const models = Array.isArray(raw.models) ? (raw.models as IncomingModel[]) : [];
      for (const model of models) {
        const modelName = String(model.name ?? '').trim();
        const modelSlug = normaliseBrand(modelName);
        if (!modelSlug) continue;

        const modelSold = int(model.count);
        const modelPrice = num(model.medianPrice) ?? observed;
        const modelSamples = modelPrice ? Array(Math.min(modelSold || 1, 50)).fill(modelPrice) : [];

        const existingModel = selectModel.get(brandId, modelSlug) as Record<string, unknown> | undefined;
        if (!existingModel) {
          const merged = mergeSamples([], modelSamples);
          insertModel.run({
            brand_id: brandId,
            slug: modelSlug,
            name: modelName,
            sold_count: modelSold,
            median_price: median(merged),
            high_price: num(model.highPrice) ?? modelPrice,
            price_samples: JSON.stringify(merged),
            at,
          });
        } else {
          const merged = mergeSamples(readSamples(existingModel.price_samples), modelSamples);
          updateModel.run({
            id: existingModel.id,
            sold_count: modelSold,
            median_price: median(merged),
            high_price: num(model.highPrice) ?? modelPrice,
            price_samples: JSON.stringify(merged),
            at,
          });
        }
        modelsTouched += 1;
      }
    }
  })();

  return { created, updated, models: modelsTouched };
}

export interface BrandRow {
  id: number;
  slug: string;
  name: string;
  tier: Tier;
  tier_source: string;
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
