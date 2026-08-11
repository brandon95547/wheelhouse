/**
 * Print the exact prompt the classifier sends, for running by hand.
 *
 * Imports SYSTEM from brand-ai.ts rather than restating it, so a prompt pasted into a chat
 * window is the one the app actually uses — a transcribed copy would drift on the first
 * edit and quietly test something else.
 *
 *   npx tsx src/scripts/dump-prompt.ts men-shoes
 *
 * The chat form joins the two messages with a separator, because a chat window has no
 * system role to put the first half in.
 */
import { db } from '../lib/db.js';
import { SYSTEM } from '../lib/brand-ai.js';

const slug = process.argv[2] ?? 'men-shoes';

const category = db
  .prepare('SELECT id, group_name, name FROM ebay_categories WHERE slug = ?')
  .get(slug) as { id: number; group_name: string; name: string } | undefined;

if (!category) {
  const known = (db.prepare('SELECT slug FROM ebay_categories ORDER BY sort_order').all() as Array<{ slug: string }>)
    .map((c) => c.slug)
    .join(', ');
  console.error(`Unknown category "${slug}". Known: ${known}`);
  process.exit(1);
}

// Same filter and same order the job uses: priced above zero, by id.
const listings = (
  db
    .prepare(
      `SELECT title, sold_price FROM ebay_listings
        WHERE sold_price IS NOT NULL AND category_id = ? ORDER BY id`,
    )
    .all(category.id) as Array<{ title: string; sold_price: number | null }>
).filter((l) => typeof l.sold_price === 'number' && Number.isFinite(l.sold_price) && l.sold_price > 0);

const user = `Here are the sold listings:\n\n${listings
  .map((l, i) => `${i}. $${l.sold_price} ${String(l.title ?? '').replace(/\s+/g, ' ').trim()}`)
  .join('\n')}`;

console.error(
  `# ${category.group_name} / ${category.name} — ${listings.length} listings, ${(SYSTEM.length + user.length)} chars\n`,
);
console.log(`${SYSTEM}\n\n---\n\n${user}`);
