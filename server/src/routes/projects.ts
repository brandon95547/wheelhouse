import { Router } from 'express';
import { db } from '../lib/db.js';
import { createResourceRouter } from '../lib/crud.js';
import { badRequest } from '../lib/errors.js';
import type { Schema } from '../lib/validate.js';

export const PROJECT_STATUSES = [
  'Planned',
  'Active',
  'Waiting',
  'Completed',
  'Cancelled',
] as const;

const projectSchema: Schema = {
  name: { type: 'string', required: true, maxLength: 160 },
  contact_id: { type: 'integer', min: 1 },
  status: { type: 'string', oneOf: PROJECT_STATUSES, default: 'Planned' },
  start_date: { type: 'date' },
  due_date: { type: 'date' },
  notes: { type: 'string', maxLength: 10_000 },
};

const router: Router = Router();

/** Rejects a contact_id that does not exist, instead of a raw FK error. */
router.use((req, _res, next) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && body.contact_id !== undefined && body.contact_id !== null && body.contact_id !== '') {
    const exists = db
      .prepare('SELECT 1 FROM contacts WHERE id = ?')
      .get(Number(body.contact_id));
    if (!exists) {
      next(badRequest('Validation failed', [
        { field: 'contact_id', message: 'Selected client no longer exists' },
      ]));
      return;
    }
  }
  next();
});

router.use(
  createResourceRouter({
    table: 'projects',
    schema: projectSchema,
    searchColumns: ['t.name', 't.notes', 'c.name', 'c.business'],
    filters: { status: 't.status', contact_id: 't.contact_id' },
    selectSql: `SELECT t.*, c.name AS contact_name, c.business AS contact_business
                  FROM projects t
                  LEFT JOIN contacts c ON c.id = t.contact_id`,
    orderBy: 't.due_date IS NULL, t.due_date ASC, t.id DESC',
  }),
);

export default router;
