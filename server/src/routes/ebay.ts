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
  cleanLookFor,
  listBrands,
  normaliseBrand,
  resolveTier,
} from '../lib/brands.js';
import { analyseBrands, applyProposals } from '../lib/brand-analysis.js';
import { classifyStatus, startClassification } from '../lib/classify-job.js';
import { aiConfigured } from '../lib/llm.js';
import { MIN_SAMPLE, RARE_GATES } from '../lib/brand-strength.js';

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

  /* Started, NOT awaited. Classification takes the better part of a minute; waiting for it
     inside the import is what made the extension time out and left the user staring at
     listings with no brands. It also runs whenever the payload had usable listings — not
     only when rows were inserted — because re-scanning the same page dedupes everything
     and previously skipped classification altogether, leaving no way to retry.

     Scoped to the category being imported into, which is the only book these listings can
     teach anything about. */
  const classifying = valid.length > 0 && aiConfigured() ? startClassification(category.id) : false;

  res.status(201).json({
    found: rawListings.length,
    imported,
    duplicates,
    failed: failed.length,
    errors: failed.slice(0, 25),
    // The brand book fills in after this response. Say so, rather than let an empty
    // Brands tab read as a failure.
    classifying,
    category: { slug: category.slug, name: category.name, group: category.group_name },
    message:
      (imported > 0
        ? `Imported ${imported} listing${imported === 1 ? '' : 's'} into ${category.group_name} / ${category.name}.`
        : 'No new listings — every one was already imported.') +
      (classifying
        ? ' Reading brands and models now; they will appear in the Brands tab shortly.'
        : aiConfigured()
          ? ''
          : ' No OPENAI_API_KEY, so no brands were read from this scan.'),
  });
});

/* ------------------------------------------------------------------- brands */

/* THE BRAND BOOK HAS ONE AUTHOR: the classifier.
 *
 * There was a POST /brands here that accepted a brand rollup from outside. It is gone,
 * and nothing should put it back. Two things arrived through it that are not brands:
 * colour names, because the caller read every refinement list on the page rather than
 * the Brand one, and the leading words of unmatched titles — "air", "nike air",
 * "jordan retro" — which are fragments of a model, not a label anyone sources by.
 *
 * Both outran the classifier by twenty seconds and filled the book before it answered.
 * A door that lets an outside guesser write brands cannot be made safe by validating
 * harder at the threshold, because the caller cannot tell a brand from a colour in the
 * first place. So the door is closed: brands come from the AI verdicts, and from the
 * hand corrections a person makes afterwards. Nothing else writes here.
 */

/**
 * What the sales say about every brand, and what tier that implies.
 *
 * Read-only. The evidence is exposed separately from the act of applying it so a tier
 * can always be interrogated — "why is this rare" has an answer with numbers in it.
 */
router.get('/brands/analysis', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const proposals = analyseBrands(
    category && category !== 'all' ? resolveCategory(category).id : undefined,
  );
  res.json({
    gates: { rare: RARE_GATES, minSample: MIN_SAMPLE },
    // Surfaced so the report can say whether tiers are coming from DeepSeek plus the
    // numbers, or from the numbers alone. A silently degraded mode is a trap.
    aiConfigured: aiConfigured(),
    proposals,
    counts: {
      rare: proposals.filter((p) => p.proposedTier === 'rare').length,
      common: proposals.filter((p) => p.proposedTier === 'common').length,
      unsorted: proposals.filter((p) => p.proposedTier === 'unsorted').length,
      /* Brands where the arithmetic and the book disagree. It used to mean "would be
         changed by pressing Apply", minus the locked ones; nothing is applied any more, so
         it means what it says — a disagreement worth a look, not a pending action. */
      changed: proposals.filter((p) => p.changed).length,
      locked: proposals.length,
    },
  });
});

/**
 * Classify the listings already stored — the button that rebuilds the brand book.
 *
 * Runs against everything imported, not just the last scan, so a book can be rebuilt at
 * any time without re-scanning eBay. Returns immediately; poll the GET below.
 */
router.post('/brands/classify', (req, res) => {
  if (!aiConfigured()) {
    throw badRequest('Validation failed', [
      { field: 'ai', message: 'OPENAI_API_KEY is not set, so brands cannot be classified.' },
    ]);
  }

  /* A category is required, and "all" is no longer accepted. Brands are judged inside one
     category, so a run across every category at once would have to decide which book a
     brand belongs to — the exact guess this design exists to avoid. */
  const started = startClassification(resolveCategory(req.body?.category).id);
  res.status(started ? 202 : 409).json({
    started,
    ...classifyStatus(),
    message: started
      ? 'Classifying brands from the imported listings. This takes about a minute.'
      : 'A classification run is already in progress.',
  });
});

/** How the current or last classification run went. */
router.get('/brands/classify', (_req, res) => {
  res.json({ ...classifyStatus(), aiConfigured: aiConfigured() });
});

/**
 * Re-score every brand — and write nothing.
 *
 * The endpoint stays because the client still calls it and because the arithmetic behind
 * it is still worth reading; what it no longer has is the authority to act on the answer.
 * Once a brand is in the book its tier is the user's, so the honest response is the count
 * of brands that were looked at and left exactly as they were. See applyProposals.
 */
router.post('/brands/rescore', (req, res) => {
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  const proposals = analyseBrands(
    category && category !== 'all' ? resolveCategory(category).id : undefined,
  );
  const result = applyProposals(proposals);
  const differ = proposals.filter((p) => p.changed).length;
  res.json({
    ...result,
    proposals: differ,
    message: differ
      ? `${differ} brand${differ === 1 ? '' : 's'} would be tiered differently by the sold prices. None were changed — tiers are yours to move.`
      : 'The sold prices agree with every tier in the book.',
  });
});

router.get('/brands', (req, res) => {
  const tier = typeof req.query.tier === 'string' ? req.query.tier : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const categoryId = category && category !== 'all' ? resolveCategory(category).id : undefined;

  const brands = listBrands({ tier, search, categoryId });
  res.json({
    category: category && category !== 'all' ? category : 'all',
    brands,
    counts: {
      rare: brands.filter((b) => b.tier === 'rare').length,
      common: brands.filter((b) => b.tier === 'common').length,
      unsorted: brands.filter((b) => b.tier === 'unsorted').length,
      not_worthy: brands.filter((b) => b.tier === 'not_worthy').length,
    },
  });
});

/** Move a brand between tiers, or annotate it. The correction path. */
router.patch('/brands/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');

  const existing = db.prepare('SELECT * FROM ebay_brands WHERE id = ?').get(id) as
    | { tier: string; look_for: string | null; locked: number }
    | undefined;
  if (!existing) throw notFound('No brand with that id');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  // The lock is set and cleared here, and it is the one field a locked brand still
  // accepts — otherwise unlocking would require deleting the row it protects.
  if (body.locked !== undefined) {
    sets.push('locked = @locked');
    params.locked = body.locked ? 1 : 0;
  }

  // A pinned brand refuses every other edit. The point of the pin is that nothing
  // changes this row, and "nothing" has to include a hand slip as well as a re-score.
  const unlocking = body.locked !== undefined && !body.locked;
  if (existing.locked === 1 && !unlocking && Object.keys(body).some((k) => k !== 'locked')) {
    throw badRequest('Validation failed', [
      { field: 'locked', message: `${'This brand is locked'}. Unlock it before changing its tier, description or name.` },
    ]);
  }

  // Tier and description are one decision, so they are validated as one even when the
  // request only mentions the tier — the row may already carry a usable description.
  const wantsTier = body.tier !== undefined;
  const wantsLookFor = body.look_for !== undefined;

  if (wantsTier || wantsLookFor) {
    const tier = wantsTier ? String(body.tier) : existing.tier;
    if (!TIERS.includes(tier as never)) {
      throw badRequest(`tier must be one of: ${TIERS.join(', ')}`);
    }

    const supplied = wantsLookFor ? cleanLookFor(body.look_for) : cleanLookFor(existing.look_for);
    const resolved = resolveTier(tier as never, supplied);

    // Refuse rather than silently file it elsewhere. A PATCH is someone stating a
    // judgement, and quietly downgrading it would leave them believing the opposite.
    if (tier === 'common' && resolved.tier !== 'common') {
      throw badRequest('Validation failed', [
        {
          field: 'look_for',
          message:
            'A common brand needs a "Look for" description naming the models, lines, materials, vintages, collaborations or editions worth buying. Without one, leave it unsorted.',
        },
      ]);
    }

    sets.push('tier = @tier', 'look_for = @look_for');
    params.tier = resolved.tier;
    params.look_for = resolved.look_for;
    if (wantsTier) sets.push("tier_source = 'manual'");
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

  const brand = db.prepare('SELECT name, locked FROM ebay_brands WHERE id = ?').get(id) as
    | { name: string; locked: number }
    | undefined;
  if (!brand) throw notFound('No brand with that id');
  if (brand.locked === 1) {
    throw badRequest('Validation failed', [
      { field: 'locked', message: `${brand.name} is locked. Unlock it first if you really want it gone.` },
    ]);
  }

  db.prepare('DELETE FROM ebay_brands WHERE id = ?').run(id);
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
