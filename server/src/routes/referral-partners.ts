import { Router } from 'express';
import { createResourceRouter } from '../lib/crud.js';
import type { Schema } from '../lib/validate.js';

const partnerSchema: Schema = {
  name: { type: 'string', required: true, maxLength: 120 },
  company: { type: 'string', maxLength: 160 },
  industry: { type: 'string', maxLength: 120 },
  email: { type: 'string', maxLength: 200 },
  phone: { type: 'string', maxLength: 60 },
  website: { type: 'string', maxLength: 300 },
  notes: { type: 'string', maxLength: 10_000 },
  referrals_sent: { type: 'integer', min: 0, max: 100_000, default: 0 },
  referrals_received: { type: 'integer', min: 0, max: 100_000, default: 0 },
};

const router: Router = createResourceRouter({
  table: 'referral_partners',
  schema: partnerSchema,
  searchColumns: [
    't.name',
    't.company',
    't.industry',
    't.email',
    't.phone',
    't.notes',
  ],
  filters: { industry: 't.industry' },
  orderBy: 't.name COLLATE NOCASE ASC',
});

export default router;
