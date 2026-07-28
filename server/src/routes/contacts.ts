import { Router } from 'express';
import { db } from '../lib/db.js';
import { createResourceRouter } from '../lib/crud.js';
import { notFound } from '../lib/errors.js';
import { parseId, type Schema } from '../lib/validate.js';

const CONTACT_TYPES = ['Prospect', 'Client', 'Partner'] as const;
const CONTACT_STATUSES = ['Active', 'Inactive', 'Archived'] as const;

const contactSchema: Schema = {
  name: { type: 'string', required: true, maxLength: 120 },
  business: { type: 'string', maxLength: 160 },
  email: { type: 'string', maxLength: 200 },
  phone: { type: 'string', maxLength: 60 },
  website: { type: 'string', maxLength: 300 },
  contact_type: { type: 'string', oneOf: CONTACT_TYPES, default: 'Prospect' },
  status: { type: 'string', oneOf: CONTACT_STATUSES, default: 'Active' },
  notes: { type: 'string', maxLength: 10_000 },
  last_contacted_date: { type: 'date' },
  next_follow_up_date: { type: 'date' },
};

const router: Router = Router();

router.use(
  createResourceRouter({
    table: 'contacts',
    schema: contactSchema,
    searchColumns: [
      't.name',
      't.business',
      't.email',
      't.phone',
      't.website',
      't.notes',
    ],
    filters: { contact_type: 't.contact_type', status: 't.status' },
    selectSql: `SELECT t.*,
                       (SELECT COUNT(*) FROM projects p WHERE p.contact_id = t.id)
                         AS project_count
                  FROM contacts t`,
  }),
);

/** Projects attached to one contact, for the contact detail panel. */
router.get('/:id/projects', (req, res) => {
  const id = parseId(req.params.id);
  const exists = db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id);
  if (!exists) throw notFound('No contact with that id');

  res.json(
    db
      .prepare(
        `SELECT * FROM projects WHERE contact_id = ? ORDER BY due_date IS NULL, due_date, id DESC`,
      )
      .all(id),
  );
});

export default router;
