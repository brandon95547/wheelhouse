import { Router } from 'express';
import { DB_PATH, clearAllData, getOptions } from '../lib/db.js';

const router: Router = Router();
const startedAt = new Date().toISOString();

/** Option lists the UI renders in its selects (seeded configuration). */
router.get('/options', (_req, res) => {
  res.json(getOptions());
});

/** Basic application information for the Settings page. */
router.get('/info', (_req, res) => {
  res.json({
    name: 'Wheelhouse',
    tagline: 'Your business command center.',
    version: process.env.npm_package_version ?? '0.1.0',
    node_version: process.version,
    database_path: DB_PATH,
    started_at: startedAt,
    uptime_seconds: Math.round(process.uptime()),
  });
});

/**
 * Wipes every business record. Configuration (categories, option lists) is
 * kept so the app still works afterwards. Guarded by a confirmation dialog in
 * the UI; the header below makes an accidental curl far less likely.
 */
router.delete('/data', (req, res) => {
  if (req.get('X-Confirm-Clear') !== 'yes') {
    res.status(428).json({
      error: 'Confirmation required',
      message:
        'Send the header X-Confirm-Clear: yes to confirm clearing all Wheelhouse data.',
    });
    return;
  }

  const deleted = clearAllData();
  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  res.json({
    deleted,
    total,
    message: `Cleared ${total} record${total === 1 ? '' : 's'}.`,
  });
});

export default router;
