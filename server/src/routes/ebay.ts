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
