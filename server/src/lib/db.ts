import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Database lives in server/data/wheelhouse.db by default.
 * Override with WHEELHOUSE_DB_PATH.
 */
const DEFAULT_DB_DIR = path.resolve(__dirname, '../../data');
export const DB_PATH =
  process.env.WHEELHOUSE_DB_PATH ?? path.join(DEFAULT_DB_DIR, 'wheelhouse.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  business_name       TEXT,
  email               TEXT,
  phone               TEXT,
  website             TEXT,
  source              TEXT,
  status              TEXT    NOT NULL DEFAULT 'New',
  notes               TEXT,
  follow_up_date      TEXT,
  converted_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  business             TEXT,
  email                TEXT,
  phone                TEXT,
  website              TEXT,
  contact_type         TEXT    NOT NULL DEFAULT 'Prospect',
  status               TEXT    NOT NULL DEFAULT 'Active',
  notes                TEXT,
  last_contacted_date  TEXT,
  next_follow_up_date  TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_partners (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  company            TEXT,
  industry           TEXT,
  email              TEXT,
  phone              TEXT,
  website            TEXT,
  notes              TEXT,
  referrals_sent     INTEGER NOT NULL DEFAULT 0,
  referrals_received INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  status     TEXT    NOT NULL DEFAULT 'Planned',
  start_date TEXT,
  due_date   TEXT,
  notes      TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  "time"     TEXT,
  event_type TEXT    NOT NULL DEFAULT 'Meeting',
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  notes      TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  body             TEXT,
  tags             TEXT    NOT NULL DEFAULT '[]',
  contact_id       INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id          INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ebay_category_id INTEGER REFERENCES ebay_categories(id) ON DELETE SET NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

/* Configuration table — seeded with category names only, never with listings. */
CREATE TABLE IF NOT EXISTS ebay_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  group_name TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ebay_listings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id    INTEGER NOT NULL REFERENCES ebay_categories(id) ON DELETE CASCADE,
  item_id        TEXT,
  title          TEXT    NOT NULL,
  sold_price     REAL,
  shipping_price REAL,
  total_price    REAL,
  sold_date      TEXT,
  condition      TEXT,
  image_url      TEXT,
  item_url       TEXT,
  dedupe_key     TEXT    NOT NULL UNIQUE,
  source_page    TEXT,
  imported_at    TEXT    NOT NULL
);

/* The brand book, learned from what actually sold.
 *
 * TWO TIERS, which is the whole point:
 *
 *   rare    the label alone is reason to inspect — you will not see many
 *   common  the label is everywhere; only certain models carry value
 *
 * plus "unsorted" for brands seen in an import that no guide covers yet. Those are
 * not noise: a brand selling repeatedly at real money that nobody has classified is
 * exactly what the next revision of the guide should absorb, and they need somewhere
 * to sit while that judgement is made.
 *
 * "slug" is the normalised name and it is UNIQUE, so "Dr. Martens", "Dr Martens" and
 * "DR. MARTENS" are one row however many imports they arrive in.
 *
 * "price_samples" holds a bounded JSON array of observed sold prices. A running
 * average would be cheaper, but the median is what matters for resale — one $900
 * outlier should not crown a brand — and a median cannot be computed from a running
 * total. Bounded so a brand with ten thousand sales does not grow without limit. */
CREATE TABLE IF NOT EXISTS ebay_brands (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  tier           TEXT    NOT NULL DEFAULT 'unsorted',
  tier_source    TEXT    NOT NULL DEFAULT 'import',
  kind           TEXT,
  sold_count     INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  median_price   REAL,
  high_price     REAL,
  price_samples  TEXT    NOT NULL DEFAULT '[]',
  look_for       TEXT,
  notes          TEXT,
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL
);

/* Models within a brand, and the reason this table exists:
 *
 * "Nike Jordan" is worth picking up, but Nike made Jordan models that are not. A tier
 * on the BRAND cannot express that, so the exception has to live one level down. Rows
 * come from two places and both matter:
 *
 *   verdict = 'worthy'      what the guide named — Jordan, SB Dunk, 990
 *   verdict = 'not_worthy'  an exclusion, almost always added by hand after seeing a
 *                           model come back that should not have
 *
 * Exclusions are checked BEFORE inclusions, so a more specific "jordan delta" beats
 * the broader "jordan" it sits inside. That ordering is what lets the book get more
 * precise over time without anyone rewriting the guide. */
CREATE TABLE IF NOT EXISTS ebay_brand_models (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id       INTEGER NOT NULL REFERENCES ebay_brands(id) ON DELETE CASCADE,
  slug           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  verdict        TEXT    NOT NULL DEFAULT 'worthy',
  verdict_source TEXT    NOT NULL DEFAULT 'guide',
  sold_count     INTEGER NOT NULL DEFAULT 0,
  median_price   REAL,
  high_price     REAL,
  price_samples  TEXT    NOT NULL DEFAULT '[]',
  notes          TEXT,
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL,
  UNIQUE (brand_id, slug)
);

/* Configuration table — seeded with the option lists the UI offers. */
CREATE TABLE IF NOT EXISTS option_values (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (domain, value)
);

CREATE INDEX IF NOT EXISTS idx_leads_status        ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up     ON leads(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_contacts_type       ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_follow_up  ON contacts(next_follow_up_date);
CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_contact    ON projects(contact_id);
CREATE INDEX IF NOT EXISTS idx_events_date         ON events(date);
CREATE INDEX IF NOT EXISTS idx_listings_category   ON ebay_listings(category_id);
CREATE INDEX IF NOT EXISTS idx_listings_item_id    ON ebay_listings(item_id);
CREATE INDEX IF NOT EXISTS idx_brands_tier         ON ebay_brands(tier);
CREATE INDEX IF NOT EXISTS idx_brand_models_brand  ON ebay_brand_models(brand_id);
`;

/**
 * Configuration seed data. These are option lists and category names — not
 * business records. No leads, contacts, projects, events, notes or eBay
 * listings are ever seeded; those tables start and stay empty until the user
 * adds data.
 */
const EBAY_CATEGORIES: Array<[group: string, name: string]> = [
  ['Media', 'Books'],
  ['Media', 'DVDs'],
  ['Media', 'VHS Tapes'],
  ['Men', 'Shirts'],
  ['Men', 'Jeans'],
  ['Men', 'Jackets'],
  ['Men', 'Shoes'],
  ['Men', 'Boots'],
  ['Women', 'Shirts'],
  ['Women', 'Jeans'],
  ['Women', 'Jackets'],
  ['Women', 'Shoes'],
  ['Women', 'Boots'],
];

const OPTION_VALUES: Record<string, string[]> = {
  lead_status: ['New', 'Contacted', 'Follow-up', 'Qualified', 'Won', 'Lost'],
  lead_source: [
    'Referral',
    'Website',
    'Cold outreach',
    'Networking event',
    'Social media',
    'Repeat client',
    'Other',
  ],
  contact_type: ['Prospect', 'Client', 'Partner'],
  contact_status: ['Active', 'Inactive', 'Archived'],
  project_status: ['Planned', 'Active', 'Waiting', 'Completed', 'Cancelled'],
  event_type: [
    'Meeting',
    'Follow-up',
    'Networking event',
    'Project deadline',
    'Reminder',
  ],
};

export function slugify(group: string, name: string): string {
  return `${group}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a no-op on a
 * database that already has the table, so a new column has to be added by hand — and
 * added idempotently, because migrate() runs on every boot.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  // What to look for in a common brand. A common brand without it is not a buy signal,
  // it is just a famous name, so the API refuses to file one as common while it is null.
  ['ebay_brands', 'look_for', 'TEXT'],
];

export function migrate(): void {
  db.exec(SCHEMA);

  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  const insertCategory = db.prepare(
    `INSERT INTO ebay_categories (slug, group_name, name, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET group_name = excluded.group_name,
                                     name       = excluded.name,
                                     sort_order = excluded.sort_order`,
  );
  const insertOption = db.prepare(
    `INSERT INTO option_values (domain, value, sort_order)
     VALUES (?, ?, ?)
     ON CONFLICT(domain, value) DO UPDATE SET sort_order = excluded.sort_order`,
  );

  db.transaction(() => {
    EBAY_CATEGORIES.forEach(([group, name], i) => {
      insertCategory.run(slugify(group, name), group, name, i);
    });
    for (const [domain, values] of Object.entries(OPTION_VALUES)) {
      values.forEach((value, i) => insertOption.run(domain, value, i));
    }
  })();
}

/** Option lists, grouped by domain, for the client to render its selects. */
export function getOptions(): Record<string, string[]> {
  const rows = db
    .prepare(
      `SELECT domain, value FROM option_values ORDER BY domain, sort_order, value`,
    )
    .all() as Array<{ domain: string; value: string }>;

  const out: Record<string, string[]> = {};
  for (const row of rows) (out[row.domain] ??= []).push(row.value);
  return out;
}

/** Deletes every business record. Configuration tables are left intact. */
export function clearAllData(): Record<string, number> {
  const tables = [
    'ebay_listings',
    'notes',
    'events',
    'projects',
    'leads',
    'contacts',
    'referral_partners',
  ];
  const deleted: Record<string, number> = {};
  db.transaction(() => {
    for (const table of tables) {
      const info = db.prepare(`DELETE FROM ${table}`).run();
      deleted[table] = info.changes;
    }
    db.prepare(
      `DELETE FROM sqlite_sequence WHERE name IN (${tables.map(() => '?').join(', ')})`,
    ).run(...tables);
  })();
  return deleted;
}
