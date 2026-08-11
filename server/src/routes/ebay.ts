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
import {
  analyseBrands,
  applyProposals,
  applyReading,
  attributeListings,
  refreshBrandStats,
} from '../lib/brand-analysis.js';
import { parseBrandPaste } from '../lib/brand-paste.js';
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

  /* Match what just arrived against the book, and only against the book.
   *
   * This used to start a background job that sent the whole scan to a language model and
   * filed whatever came back. That is gone — no key, no call, no job, no waiting. What is
   * left is arithmetic on brands you already put there: a new listing whose title carries a
   * known brand joins that brand's sold count and median immediately, and a listing whose
   * brand is not in the book yet simply waits until you add it.
   *
   * Cheap enough to do inline, unlike the thing it replaces. Scoped to the category being
   * imported into, which is the only book these listings can belong to. */
  let attributed = 0;
  if (imported > 0) {
    attributed = attributeListings(category.id);
    refreshBrandStats(category.id);
  }

  res.status(201).json({
    found: rawListings.length,
    imported,
    duplicates,
    failed: failed.length,
    errors: failed.slice(0, 25),
    attributed,
    category: { slug: category.slug, name: category.name, group: category.group_name },
    message:
      imported > 0
        ? `Imported ${imported} listing${imported === 1 ? '' : 's'} into ${category.group_name} / ${category.name}.`
        : 'No new listings — every one was already imported.',
  });
});

/* ------------------------------------------------------------------- brands */

/* THE BRAND BOOK HAS ONE AUTHOR: YOU.
 *
 * There was a POST /brands here once that accepted a brand rollup from the extension. It
 * is gone and nothing should put it back — what arrived through it was not brands but
 * colour names, because the caller read every refinement list on the eBay page rather than
 * the Brand one, plus the leading words of unmatched titles ("air", "nike air", "jordan
 * retro"), which are fragments of a model. A door that lets an outside guesser write
 * brands cannot be made safe by validating harder at the threshold, because the caller
 * cannot tell a brand from a colour in the first place.
 *
 * For a while the answer was a language model, called from POST /brands/classify. That is
 * gone too, and the reason is the same one in a different key: it could tell a brand from a
 * colour, but it was still guessing, still costing money, and still writing rows nobody had
 * agreed to. What replaces it is POST /brands/import below — the same JSON, the same shape,
 * pasted by the person whose book it is.
 *
 * So there are exactly two ways a brand gets into this table: you paste it, or you type it.
 * Nothing else writes here.
 */

/**
 * The listings a paste's `items` numbering refers to.
 *
 * Priced above zero, ordered by id, one category — the same list dump-prompt.ts numbers
 * when it prints the prompt, and it must stay the same list or `items[].i` points at the
 * wrong shoe. Kept in this file next to its only two callers rather than exported, so the
 * definition cannot drift apart from the endpoint that depends on it.
 */
function numberedListingIds(categoryId: number): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM ebay_listings
          WHERE sold_price IS NOT NULL AND sold_price > 0 AND category_id = ?
          ORDER BY id`,
      )
      .all(categoryId) as Array<{ id: number }>
  ).map((row) => row.id);
}

/**
 * Add brands from pasted JSON — the button on the Brands tab.
 *
 * Body: `{ category, overwrite?, payload }`, where `payload` is the parsed JSON exactly as
 * it was pasted. See brand-paste.ts for the shapes accepted and brand-prompt.ts for where
 * one comes from.
 *
 * `overwrite` is off unless asked for, and it is the difference between "add what is
 * missing" and "make the book say this". Off, a brand already in the category is left
 * untouched however emphatically the paste disagrees with it; on, unlocked brands are moved
 * and locked ones are refused and counted. Either way the answer says which happened to how
 * many, because a bulk write that reports only a total is indistinguishable from one that
 * quietly did nothing.
 */
router.post('/brands/import', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const category = resolveCategory(body.category ?? body.categorySlug);

  let parsed;
  try {
    parsed = parseBrandPaste(body.payload ?? body.brands ?? body);
  } catch (error) {
    throw badRequest('Validation failed', [
      { field: 'payload', message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  if (!parsed.brands.length) {
    throw badRequest('Validation failed', [
      {
        field: 'payload',
        message: parsed.problems.length
          ? `Nothing could be filed. ${parsed.problems[0]}`
          : 'No brands in that JSON — the "brands" array is empty.',
      },
    ]);
  }

  const result = applyReading(category.id, parsed, numberedListingIds(category.id), {
    overwrite: Boolean(body.overwrite),
  });

  const said: string[] = [];
  if (result.created) said.push(`${result.created} brand${result.created === 1 ? '' : 's'} added`);
  if (result.updated) said.push(`${result.updated} changed`);
  if (result.untouched) said.push(`${result.untouched} left as ${result.untouched === 1 ? 'it was' : 'they were'}`);
  if (result.locked) said.push(`${result.locked} locked and skipped`);
  if (result.models) said.push(`${result.models} new model${result.models === 1 ? '' : 's'}`);

  res.status(201).json({
    ...result,
    problems: parsed.problems,
    category: { slug: category.slug, name: category.name, group: category.group_name },
    message: `${said.join(', ') || 'Nothing to do'} in ${category.group_name} / ${category.name}.`,
  });
});

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
 * Re-match every listing against the book, then re-score — and move nothing.
 *
 * Two different things, and only the first one writes. Attribution is arithmetic: which
 * listing carries which brand, and which model within it. Re-running it is how a brand
 * added today picks up the sales that were imported last month, and it is the only way a
 * book edited by hand keeps its counts honest.
 *
 * Scoring is the part that does NOT write. Once a brand is in the book its tier is yours,
 * so the honest response is the count of brands the sold prices would file differently,
 * offered as a suggestion. See applyProposals.
 */
router.post('/brands/rescore', (req, res) => {
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  const categoryId = category && category !== 'all' ? resolveCategory(category).id : undefined;

  /* Every category when none is named. Attribution never crosses a category — a listing
     can only match a brand in its own book — so doing them one at a time is the same work
     as doing them together, minus the chance of reading across the line by accident. */
  const ids = categoryId
    ? [categoryId]
    : (db.prepare('SELECT id FROM ebay_categories').all() as Array<{ id: number }>).map((c) => c.id);

  let attributed = 0;
  for (const id of ids) attributed += attributeListings(id);
  refreshBrandStats(categoryId);

  const proposals = analyseBrands(categoryId);
  const result = applyProposals(proposals);
  const differ = proposals.filter((p) => p.changed).length;

  res.json({
    ...result,
    attributed,
    proposals: differ,
    message:
      `${attributed} listing${attributed === 1 ? '' : 's'} matched to a brand. ` +
      (differ
        ? `${differ} brand${differ === 1 ? '' : 's'} would be tiered differently by the sold prices. None were changed — tiers are yours to move.`
        : 'The sold prices agree with every tier in the book.'),
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
