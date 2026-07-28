import { Router } from 'express';
import { db } from '../lib/db.js';
import { createResourceRouter } from '../lib/crud.js';
import { badRequest } from '../lib/errors.js';
import type { Schema } from '../lib/validate.js';

const noteSchema: Schema = {
  title: { type: 'string', required: true, maxLength: 200 },
  body: { type: 'string', maxLength: 50_000 },
  // Stored as a JSON array string; normalised by the middleware below.
  tags: { type: 'string', maxLength: 2_000, default: '[]' },
  contact_id: { type: 'integer', min: 1 },
  lead_id: { type: 'integer', min: 1 },
  project_id: { type: 'integer', min: 1 },
  ebay_category_id: { type: 'integer', min: 1 },
};

/** Accepts either an array of tags or a comma-separated string. */
function normaliseTags(raw: unknown): string {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((t) => String(t));
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed.map((t) => String(t));
      } catch {
        list = trimmed.split(',');
      }
    } else {
      list = trimmed.split(',');
    }
  }

  const cleaned = [
    ...new Set(
      list.map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 25),
    ),
  ];
  return JSON.stringify(cleaned);
}

const router: Router = Router();

router.use((req, _res, next) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && 'tags' in body) body.tags = normaliseTags(body.tags);

  const relations: Array<[string, string, string]> = [
    ['contact_id', 'contacts', 'Selected contact no longer exists'],
    ['lead_id', 'leads', 'Selected lead no longer exists'],
    ['project_id', 'projects', 'Selected project no longer exists'],
    ['ebay_category_id', 'ebay_categories', 'Selected eBay category no longer exists'],
  ];
  if (body) {
    for (const [field, table, message] of relations) {
      const value = body[field];
      if (value === undefined || value === null || value === '') continue;
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(value))) {
        next(badRequest('Validation failed', [{ field, message }]));
        return;
      }
    }
  }
  next();
});

router.use(
  createResourceRouter({
    table: 'notes',
    schema: noteSchema,
    searchColumns: ['t.title', 't.body', 't.tags'],
    filters: {
      contact_id: 't.contact_id',
      lead_id: 't.lead_id',
      project_id: 't.project_id',
      ebay_category_id: 't.ebay_category_id',
    },
    selectSql: `SELECT t.*,
                       c.name  AS contact_name,
                       l.name  AS lead_name,
                       p.name  AS project_name,
                       ec.group_name || ' / ' || ec.name AS ebay_category_name
                  FROM notes t
                  LEFT JOIN contacts        c  ON c.id  = t.contact_id
                  LEFT JOIN leads           l  ON l.id  = t.lead_id
                  LEFT JOIN projects        p  ON p.id  = t.project_id
                  LEFT JOIN ebay_categories ec ON ec.id = t.ebay_category_id`,
    orderBy: 't.updated_at DESC, t.id DESC',
  }),
);

export default router;
