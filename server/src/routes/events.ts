import { Router } from 'express';
import { db } from '../lib/db.js';
import { createResourceRouter } from '../lib/crud.js';
import { badRequest } from '../lib/errors.js';
import type { Schema } from '../lib/validate.js';

export const EVENT_TYPES = [
  'Meeting',
  'Follow-up',
  'Networking event',
  'Project deadline',
  'Reminder',
] as const;

const eventSchema: Schema = {
  title: { type: 'string', required: true, maxLength: 160 },
  date: { type: 'date', required: true },
  time: { type: 'time' },
  event_type: { type: 'string', oneOf: EVENT_TYPES, default: 'Meeting' },
  contact_id: { type: 'integer', min: 1 },
  project_id: { type: 'integer', min: 1 },
  notes: { type: 'string', maxLength: 10_000 },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const router: Router = Router();

/** Rejects related ids that no longer exist, instead of a raw FK error. */
router.use((req, _res, next) => {
  const body = req.body as Record<string, unknown> | undefined;
  const relations: Array<[string, string, string]> = [
    ['contact_id', 'contacts', 'Selected contact no longer exists'],
    ['project_id', 'projects', 'Selected project no longer exists'],
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
    table: 'events',
    schema: eventSchema,
    searchColumns: ['t.title', 't.notes', 'c.name', 'p.name'],
    filters: { event_type: 't.event_type', date: 't.date' },
    // `from` / `to` drive the month grid on the Calendar page.
    extraWhere: (req) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      if (DATE_RE.test(from)) {
        clauses.push('t.date >= ?');
        params.push(from);
      }
      if (DATE_RE.test(to)) {
        clauses.push('t.date <= ?');
        params.push(to);
      }
      return clauses.length ? { sql: clauses.join(' AND '), params } : null;
    },
    selectSql: `SELECT t.*, c.name AS contact_name, p.name AS project_name
                  FROM events t
                  LEFT JOIN contacts c ON c.id = t.contact_id
                  LEFT JOIN projects p ON p.id = t.project_id`,
    orderBy: 't.date ASC, t."time" IS NULL, t."time" ASC, t.id ASC',
  }),
);

export default router;
