import { Router } from 'express';
import { db } from '../lib/db.js';

const router: Router = Router();

/** Local calendar date as YYYY-MM-DD, so "due today" matches the user's day. */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Every number here is read straight out of the database. With an empty
 * database the response is all zeros and empty arrays — nothing is invented.
 */
router.get('/', (_req, res) => {
  const today = todayIso();

  const metrics = {
    open_leads: count(
      `SELECT COUNT(*) AS n FROM leads WHERE status NOT IN ('Won', 'Lost')`,
    ),
    active_clients: count(
      `SELECT COUNT(*) AS n FROM contacts
        WHERE contact_type = 'Client' AND status = 'Active'`,
    ),
    active_projects: count(
      `SELECT COUNT(*) AS n FROM projects WHERE status = 'Active'`,
    ),
    follow_ups_due: count(
      `SELECT (
         (SELECT COUNT(*) FROM leads
           WHERE follow_up_date IS NOT NULL AND follow_up_date <= ?
             AND status NOT IN ('Won', 'Lost'))
         +
         (SELECT COUNT(*) FROM contacts
           WHERE next_follow_up_date IS NOT NULL AND next_follow_up_date <= ?
             AND status = 'Active')
       ) AS n`,
      today,
      today,
    ),
    upcoming_events: count(
      `SELECT COUNT(*) AS n FROM events WHERE date >= ?`,
      today,
    ),
    imported_listings: count(`SELECT COUNT(*) AS n FROM ebay_listings`),
  };

  const followUps = db
    .prepare(
      `SELECT 'lead' AS kind, id, name AS label, business_name AS detail,
              follow_up_date AS due_date, status
         FROM leads
        WHERE follow_up_date IS NOT NULL AND follow_up_date <= ?
          AND status NOT IN ('Won', 'Lost')
       UNION ALL
       SELECT 'contact' AS kind, id, name AS label, business AS detail,
              next_follow_up_date AS due_date, status
         FROM contacts
        WHERE next_follow_up_date IS NOT NULL AND next_follow_up_date <= ?
          AND status = 'Active'
       ORDER BY due_date ASC
       LIMIT 8`,
    )
    .all(today, today);

  const upcomingEvents = db
    .prepare(
      `SELECT e.id, e.title, e.date, e."time", e.event_type,
              c.name AS contact_name, p.name AS project_name
         FROM events e
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.date >= ?
        ORDER BY e.date ASC, e."time" IS NULL, e."time" ASC
        LIMIT 8`,
    )
    .all(today);

  const activeProjects = db
    .prepare(
      `SELECT p.id, p.name, p.status, p.due_date, c.name AS contact_name
         FROM projects p
         LEFT JOIN contacts c ON c.id = p.contact_id
        WHERE p.status IN ('Active', 'Waiting')
        ORDER BY p.due_date IS NULL, p.due_date ASC
        LIMIT 8`,
    )
    .all();

  const totals = {
    leads: count('SELECT COUNT(*) AS n FROM leads'),
    contacts: count('SELECT COUNT(*) AS n FROM contacts'),
    referral_partners: count('SELECT COUNT(*) AS n FROM referral_partners'),
    projects: count('SELECT COUNT(*) AS n FROM projects'),
    events: count('SELECT COUNT(*) AS n FROM events'),
    notes: count('SELECT COUNT(*) AS n FROM notes'),
    ebay_listings: count('SELECT COUNT(*) AS n FROM ebay_listings'),
  };

  res.json({
    today,
    metrics,
    follow_ups: followUps,
    upcoming_events: upcomingEvents,
    active_projects: activeProjects,
    totals,
    is_empty: Object.values(totals).every((value) => value === 0),
  });
});

export default router;
