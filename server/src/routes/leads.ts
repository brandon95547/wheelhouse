import { Router } from 'express';
import { db } from '../lib/db.js';
import { createResourceRouter, nowIso } from '../lib/crud.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { parseId, type Schema } from '../lib/validate.js';

export const LEAD_STATUSES = [
  'New',
  'Contacted',
  'Follow-up',
  'Qualified',
  'Won',
  'Lost',
] as const;

const CONTACT_TYPES = ['Prospect', 'Client', 'Partner'] as const;

const leadSchema: Schema = {
  name: { type: 'string', required: true, maxLength: 120 },
  business_name: { type: 'string', maxLength: 160 },
  email: { type: 'string', maxLength: 200 },
  phone: { type: 'string', maxLength: 60 },
  website: { type: 'string', maxLength: 300 },
  source: { type: 'string', maxLength: 80 },
  status: { type: 'string', oneOf: LEAD_STATUSES, default: 'New' },
  notes: { type: 'string', maxLength: 10_000 },
  follow_up_date: { type: 'date' },
};

const router: Router = Router();

router.use(
  createResourceRouter({
    table: 'leads',
    schema: leadSchema,
    searchColumns: [
      't.name',
      't.business_name',
      't.email',
      't.phone',
      't.source',
      't.notes',
    ],
    filters: { status: 't.status', source: 't.source' },
    selectSql: `SELECT t.*, c.name AS converted_contact_name
                  FROM leads t
                  LEFT JOIN contacts c ON c.id = t.converted_contact_id`,
  }),
);

/**
 * Converts a lead into a CRM contact. The lead is kept and linked to the new
 * contact rather than deleted, so the original pipeline history survives.
 */
router.post('/:id/convert', (req, res) => {
  const id = parseId(req.params.id);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!lead) throw notFound('No lead with that id');

  if (lead.converted_contact_id) {
    throw new HttpError(
      409,
      'This lead has already been converted to a CRM contact.',
    );
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactType = String(body.contact_type ?? 'Client');
  if (!(CONTACT_TYPES as readonly string[]).includes(contactType)) {
    throw badRequest(
      `contact_type must be one of: ${CONTACT_TYPES.join(', ')}`,
    );
  }
  const markWon =
    body.mark_won === undefined ? contactType === 'Client' : Boolean(body.mark_won);

  const timestamp = nowIso();

  const contactId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO contacts
           (name, business, email, phone, website, contact_type, status, notes,
            next_follow_up_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?)`,
      )
      .run(
        lead.name as string,
        lead.business_name as string | null,
        lead.email as string | null,
        lead.phone as string | null,
        lead.website as string | null,
        contactType,
        lead.notes as string | null,
        lead.follow_up_date as string | null,
        timestamp,
        timestamp,
      );

    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `UPDATE leads
          SET converted_contact_id = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(newId, markWon ? 'Won' : (lead.status as string), timestamp, id);

    return newId;
  })();

  res.status(201).json({
    contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId),
    lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(id),
  });
});

export default router;
