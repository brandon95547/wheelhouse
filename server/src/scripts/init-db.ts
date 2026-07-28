/**
 * Creates the SQLite file and applies the schema.
 *
 * Only configuration is seeded (eBay category names and the option lists the
 * UI offers). No leads, contacts, partners, projects, events, notes or eBay
 * listings are created — those tables start empty.
 */
import { DB_PATH, db, migrate } from '../lib/db.js';

migrate();

const tables = [
  'leads',
  'contacts',
  'referral_partners',
  'projects',
  'events',
  'notes',
  'ebay_listings',
  'ebay_categories',
  'option_values',
];

console.log(`Wheelhouse database ready at ${DB_PATH}\n`);
console.log('Table                Rows');
console.log('-------------------- ----');
for (const table of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  console.log(`${table.padEnd(20)} ${String(n).padStart(4)}`);
}
console.log('\nBusiness tables start empty by design.');
