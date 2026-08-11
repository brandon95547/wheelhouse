/**
 * Print the brand-classification prompt, followed by a category's sold listings.
 *
 * THE APP NO LONGER SENDS THIS ANYWHERE. Wheelhouse has no API key and makes no model
 * calls; this script exists so you can take the question somewhere yourself and paste the
 * answer back into "Add brands" on the Brands tab.
 *
 *   npx tsx src/scripts/dump-prompt.ts men-shoes
 *   npx tsx src/scripts/dump-prompt.ts men-shoes > /tmp/prompt.txt
 *
 * The two halves are joined by a `---` separator because a chat window has no system role
 * to put the first one in — paste the whole thing as a single message.
 *
 * The numbering below is what a pasted `items[].i` refers to, and the import endpoint
 * rebuilds this exact list to read it. Same filter, same order, same category: priced above
 * zero, by id. Import more listings in between and the numbers no longer line up.
 */
import { db } from '../lib/db.js';
import { SYSTEM } from '../lib/brand-prompt.js';

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
