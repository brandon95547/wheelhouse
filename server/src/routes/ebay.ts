import { Router } from 'express';
import { db } from '../lib/db.js';
import { nowIso } from '../lib/crud.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  normaliseListing,
  priceStats,
  sanitiseUrl,
  type ListingProblem,
  type NormalisedListing,
} from '../lib/ebay.js';
import {
  TIERS,
  VERDICTS,
  listBrands,
  normaliseBrand,
  upsertBrands,
} from '../lib/brands.js';

const router: Router = Router();

interface CategoryRow {
  id: number;
  slug: string;
  group_name: string;
  name: string;
  sort_order: number;
}

const MAX_LISTINGS_PER_IMPORT = 500;

function resolveCategory(raw: unknown): CategoryRow {
  if (raw === undefined || raw === null || raw === '') {
    throw badRequest('Validation failed', [
      { field: 'category', message: 'Choose a Wheelhouse category before importing' },
    ]);
  }

  const value = String(raw).trim();
  const row = (
    /^\d+$/.test(value)
      ? db.prepare('SELECT * FROM ebay_categories WHERE id = ?').get(Number(value))
      : db.prepare('SELECT * FROM ebay_categories WHERE slug = ?').get(value)
  ) as CategoryRow | undefined;

  if (!row) {
    const known = (
      db.prepare('SELECT slug FROM ebay_categories ORDER BY sort_order').all() as Array<{
        slug: string;
      }>
    ).map((c) => c.slug);
    throw badRequest('Validation failed', [
      {
        field: 'category',
        message: `Unknown category "${value}". Known categories: ${known.join(', ')}`,
      },
    ]);
  }
  return row;
}

/** Categories are configuration, seeded at migration time. */
router.get('/categories', (_req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM ebay_categories ORDER BY sort_order, id')
      .all(),
  );
});

function listingWhere(req: {
  query: Record<string, unknown>;
}): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  if (category && category !== 'all') {
    clauses.push('c.slug = ?');
    params.push(category);
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search) {
    const like = `%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(`(l.title LIKE ? ESCAPE '\\' OR l.item_id LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }

  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

const LISTING_SELECT = `SELECT l.*, c.slug AS category_slug, c.name AS category_name,
                               c.group_name AS category_group
                          FROM ebay_listings l
                          JOIN ebay_categories c ON c.id = l.category_id`;

router.get('/listings', (req, res) => {
  const where = listingWhere(req as never);
  res.json(
    db
      .prepare(
        `${LISTING_SELECT}${where.sql}
         ORDER BY l.sold_date IS NULL, l.sold_date DESC, l.id DESC`,
      )
      .all(...where.params),
  );
});

router.get('/stats', (req, res) => {
  const where = listingWhere(req as never);
  const rows = db
    .prepare(
      `SELECT l.sold_price FROM ebay_listings l
         JOIN ebay_categories c ON c.id = l.category_id${where.sql}`,
    )
    .all(...where.params) as Array<{ sold_price: number | null }>;

  const stats = priceStats(
    rows.map((r) => r.sold_price).filter((p): p is number => p !== null),
  );

  // `count` counts listings with a usable price; `total` counts every row.
  res.json({ ...stats, total: rows.length });
});

/**
 * Receives listings scraped from the page the user is already looking at.
 * Nothing here contacts eBay — the extension posts what was on screen.
 */
router.post('/import', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const category = resolveCategory(body.category ?? body.categorySlug ?? body.category_id);

  const rawListings = body.listings;
  if (!Array.isArray(rawListings)) {
    throw badRequest('Validation failed', [
      { field: 'listings', message: 'listings must be an array' },
    ]);
  }
  if (rawListings.length > MAX_LISTINGS_PER_IMPORT) {
    throw badRequest(
      `Too many listings in one import (${rawListings.length}). The limit is ${MAX_LISTINGS_PER_IMPORT}.`,
    );
  }

  const sourcePage = sanitiseUrl(body.sourceUrl ?? body.source_url);
  const importedAt = nowIso();

  const valid: NormalisedListing[] = [];
  const failed: ListingProblem[] = [];
  const seenInBatch = new Set<string>();
  let duplicatesInBatch = 0;

  rawListings.forEach((raw, index) => {
    const result = normaliseListing(raw, index);
    if ('problem' in result) {
      failed.push(result.problem);
      return;
    }
    // The same card can appear twice in one payload (carousels, sponsored rows).
    if (seenInBatch.has(result.listing.dedupe_key)) {
      duplicatesInBatch += 1;
      return;
    }
    seenInBatch.add(result.listing.dedupe_key);
    valid.push(result.listing);
  });

  const insert = db.prepare(
    `INSERT INTO ebay_listings
       (category_id, item_id, title, sold_price, shipping_price, total_price,
        sold_date, condition, image_url, item_url, dedupe_key, source_page, imported_at)
     VALUES
       (@category_id, @item_id, @title, @sold_price, @shipping_price, @total_price,
        @sold_date, @condition, @image_url, @item_url, @dedupe_key, @source_page, @imported_at)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  );

  let imported = 0;
  db.transaction(() => {
    for (const listing of valid) {
      const info = insert.run({
        ...listing,
        category_id: category.id,
        source_page: sourcePage,
        imported_at: importedAt,
      });
      if (info.changes > 0) imported += 1;
    }
  })();

  const duplicates = valid.length - imported + duplicatesInBatch;

  res.status(201).json({
    found: rawListings.length,
    imported,
    duplicates,
    failed: failed.length,
    errors: failed.slice(0, 25),
    category: { slug: category.slug, name: category.name, group: category.group_name },
    message:
      imported > 0
        ? `Imported ${imported} listing${imported === 1 ? '' : 's'} into ${category.group_name} / ${category.name}.`
        : 'No new listings were imported.',
  });
});

/* ------------------------------------------------------------------- brands */

/**
 * Receives a scan's brand rollup from the Lookout extension.
 *
 * A brand already in the book KEEPS ITS TIER. Once a human has judged a brand — or
 * corrected a judgement — a later import must not quietly overwrite it, or every
 * correction would last exactly until the next scan.
 */
router.post('/brands', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const brands = body.brands;
  if (!Array.isArray(brands)) {
    throw badRequest('Validation failed', [
      { field: 'brands', message: 'brands must be an array' },
    ]);
  }

  const result = upsertBrands(brands as never);

  // Candidates are brands no guide covers. They land as `unsorted` rather than being
  // dropped: a brand selling repeatedly that nobody has classified is the most useful
  // thing a scan can surface, and it needs somewhere to sit until it is judged.
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidateResult = upsertBrands(
    candidates.map((c) => {
      const row = (c ?? {}) as Record<string, unknown>;
      return { brand: row.name, soldCount: row.count, medianPrice: row.medianPrice };
    }) as never,
  );

  res.status(201).json({
    saved: result.created + result.updated,
    created: result.created,
    updated: result.updated,
    models: result.models,
    candidates: candidateResult.created + candidateResult.updated,
    message: `${result.created} new brand${result.created === 1 ? '' : 's'}, ${result.updated} updated, ${candidateResult.created} unsorted.`,
  });
});

router.get('/brands', (req, res) => {
  const tier = typeof req.query.tier === 'string' ? req.query.tier : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const brands = listBrands({ tier, search });
  res.json({
    brands,
    counts: {
      rare: brands.filter((b) => b.tier === 'rare').length,
      common: brands.filter((b) => b.tier === 'common').length,
      unsorted: brands.filter((b) => b.tier === 'unsorted').length,
    },
  });
});

/** Move a brand between tiers, or annotate it. The correction path. */
router.patch('/brands/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (body.tier !== undefined) {
    const tier = String(body.tier);
    if (!TIERS.includes(tier as never)) {
      throw badRequest(`tier must be one of: ${TIERS.join(', ')}`);
    }
    sets.push('tier = @tier', "tier_source = 'manual'");
    params.tier = tier;
  }
  if (body.notes !== undefined) {
    sets.push('notes = @notes');
    params.notes = body.notes === null ? null : String(body.notes).slice(0, 2000);
  }
  // Imports never change the display name, so this is the only way to tidy one.
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw badRequest('name cannot be empty');
    sets.push('name = @name');
    params.name = name.slice(0, 200);
  }
  if (!sets.length) throw badRequest('Nothing to update');

  const info = db.prepare(`UPDATE ebay_brands SET ${sets.join(', ')} WHERE id = @id`).run(params);
  if (!info.changes) throw notFound('No brand with that id');
  res.json(db.prepare('SELECT * FROM ebay_brands WHERE id = ?').get(id));
});

router.delete('/brands/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  const info = db.prepare('DELETE FROM ebay_brands WHERE id = ?').run(id);
  if (!info.changes) throw notFound('No brand with that id');
  res.json({ deleted: id });
});

/**
 * Add a model rule to a brand.
 *
 * Mostly used to record an EXCLUSION: Nike Jordan is worth picking up, but a particular
 * Jordan model is not, and only a rule below the brand can say so.
 */
router.post('/brands/:id/models', (req, res) => {
  const brandId = Number(req.params.id);
  if (!Number.isInteger(brandId) || brandId <= 0) throw badRequest('Invalid id');

  const brand = db.prepare('SELECT id FROM ebay_brands WHERE id = ?').get(brandId);
  if (!brand) throw notFound('No brand with that id');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('Validation failed', [{ field: 'name', message: 'A model name is required' }]);

  const verdict = String(body.verdict ?? 'not_worthy');
  if (!VERDICTS.includes(verdict as never)) {
    throw badRequest(`verdict must be one of: ${VERDICTS.join(', ')}`);
  }

  const at = nowIso();
  db.prepare(
    `INSERT INTO ebay_brand_models
       (brand_id, slug, name, verdict, verdict_source, first_seen, last_seen)
     VALUES (?, ?, ?, ?, 'manual', ?, ?)
     ON CONFLICT(brand_id, slug)
       DO UPDATE SET verdict = excluded.verdict,
                     verdict_source = 'manual',
                     name = excluded.name,
                     last_seen = excluded.last_seen`,
  ).run(brandId, normaliseBrand(name), name, verdict, at, at);

  res.status(201).json(
    db.prepare('SELECT * FROM ebay_brand_models WHERE brand_id = ? AND slug = ?').get(brandId, normaliseBrand(name)),
  );
});

/** Flip a model between worthy and not — the per-model correction path. */
router.patch('/brands/:id/models/:modelId', (req, res) => {
  const modelId = Number(req.params.modelId);
  if (!Number.isInteger(modelId) || modelId <= 0) throw badRequest('Invalid model id');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const verdict = String(body.verdict ?? '');
  if (!VERDICTS.includes(verdict as never)) {
    throw badRequest(`verdict must be one of: ${VERDICTS.join(', ')}`);
  }

  const info = db
    .prepare(
      `UPDATE ebay_brand_models SET verdict = ?, verdict_source = 'manual'
        WHERE id = ? AND brand_id = ?`,
    )
    .run(verdict, modelId, Number(req.params.id));
  if (!info.changes) throw notFound('No model with that id on this brand');
  res.json(db.prepare('SELECT * FROM ebay_brand_models WHERE id = ?').get(modelId));
});

router.delete('/brands/:id/models/:modelId', (req, res) => {
  const info = db
    .prepare('DELETE FROM ebay_brand_models WHERE id = ? AND brand_id = ?')
    .run(Number(req.params.modelId), Number(req.params.id));
  if (!info.changes) throw notFound('No model with that id on this brand');
  res.json({ deleted: Number(req.params.modelId) });
});

/** Clears every imported listing, or just one category with ?category=slug. */
router.delete('/listings', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';

  if (category && category !== 'all') {
    const row = db
      .prepare('SELECT id FROM ebay_categories WHERE slug = ?')
      .get(category) as { id: number } | undefined;
    if (!row) throw notFound(`No eBay category with slug "${category}"`);
    const info = db
      .prepare('DELETE FROM ebay_listings WHERE category_id = ?')
      .run(row.id);
    res.json({ deleted: info.changes, category });
    return;
  }

  const info = db.prepare('DELETE FROM ebay_listings').run();
  res.json({ deleted: info.changes, category: 'all' });
});

router.delete('/listings/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('Invalid id: expected a positive integer');
  }
  const info = db.prepare('DELETE FROM ebay_listings WHERE id = ?').run(id);
  if (!info.changes) throw notFound('No eBay listing with that id');
  res.json({ deleted: id });
});

export default router;
