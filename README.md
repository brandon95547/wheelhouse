# Wheelhouse

> Your business command center.

A small, practical business command center: leads, CRM contacts and clients,
referral partners, projects, an internal calendar, notes, and eBay sold-listing
research imported from your own browser.

The database starts empty. Nothing is seeded except configuration — the eBay
category names and the status lists the forms offer.

---

## Project structure

```text
wheelhouse/
  client/             React + TypeScript + Vite + Tailwind CSS front end
  server/             Express + SQLite REST API
  lookout/            Chrome Manifest V3 extension that reads eBay sold listings
  README.md
```

## Requirements

- Node.js 20 or newer (developed on Node 24)
- npm 10 or newer
- Google Chrome, for the browser extension

## Install

```bash
cd wheelhouse/server && npm install
cd ../client && npm install
```

## Create the database

```bash
cd wheelhouse/server
npm run db:init
```

This creates `server/data/wheelhouse.db`, applies the schema and seeds the
configuration tables only. It prints a row count per table so you can confirm
the business tables are empty.

`npm run db:reset` deletes every business record but keeps the schema and
configuration.

## Run it

Two terminals:

```bash
# Terminal 1 — API on http://localhost:4000
cd wheelhouse/server
npm run dev
```

```bash
# Terminal 2 — client on http://localhost:5173
cd wheelhouse/client
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to the API server, so both
halves work together with no extra configuration.

### Single-port production run

```bash
cd wheelhouse/client && npm run build     # writes client/dist
cd ../server && npm run dev               # or: npm run build && npm start
```

When `client/dist` exists the API server also serves the built front end, so
everything is available on <http://localhost:4000>. That is the address to give
the browser extension.

### All scripts

| Location | Command | What it does |
| --- | --- | --- |
| `server` | `npm run dev` | Start the API with reload on change |
| `server` | `npm run build` | Compile TypeScript to `dist/` |
| `server` | `npm start` | Run the compiled server |
| `server` | `npm run typecheck` | TypeScript check, no output |
| `server` | `npm run db:init` | Create the database and seed configuration |
| `server` | `npm run db:reset` | Delete all business records |
| `server` | `npx tsx src/scripts/dump-prompt.ts <category>` | Print a classification prompt plus that category's listings — see below |
| `client` | `npm run dev` | Vite dev server on port 5173 |
| `client` | `npm run build` | Type check, then production build |
| `client` | `npm run preview` | Serve the production build |
| `client` | `npm run typecheck` | TypeScript check |

Environment variables the server understands: `PORT` (default 4000), `HOST`
(default 127.0.0.1), `WHEELHOUSE_DB_PATH`, `WHEELHOUSE_CORS_ORIGIN`.

---

## Features

**Dashboard** — open leads, active clients, active projects, follow-ups due,
upcoming events and imported eBay listings, all counted from the database. With
an empty database every figure is zero and an empty state explains what to do
first.

**Leads** — add, edit, delete, search, filter by status, notes, follow-up date,
and convert a lead into a CRM contact. Converting keeps the lead and links it to
the new contact rather than deleting it. Statuses: New, Contacted, Follow-up,
Qualified, Won, Lost.

**CRM** — contacts marked as Prospect, Client or Partner, with notes, last
contacted and next follow-up dates, and a detail panel listing that contact's
projects.

**Referral Partners** — who you swap referrals with, plus running counts of
referrals sent and received with one-click increment buttons.

**Projects** — list or board view, assigned client, status, start and due dates,
notes. Statuses: Planned, Active, Waiting, Completed, Cancelled.

**Calendar** — a month grid plus a list for the visible month. Click any day to
add an event on that date. Events have a type, an optional time, and optional
links to a contact and a project. Internal only; nothing is sent to Google
Calendar or any other service.

**Notes** — title, body, comma-separated tags, and optional links to a contact,
lead, project or eBay research category. Click a tag to filter by it.

**eBay Research** — category selector, a button that opens eBay's sold listings
in a new tab, count / average / median / lowest / highest sold price, and a
table of everything imported.

**Brand book** — what to look for, built from what has actually sold. Organised
as **category → brand → model**: a brand is judged inside one category, so Nike
under Men's Shoes and Nike under Men's Shirts are separate rows with separate
tiers and separate models. Brands are Rare (the label alone is the pickup
signal), Common (only certain models pay, and the row must say which), Unsorted
or Not worth it.

Brands get into the book two ways, and both of them are you:

**Add brands** — the button on the Brands tab. Paste a block of JSON, pick the
category, and every brand in it is filed at once:

```json
{
  "brands": [
    { "name": "Danner", "tier": "rare", "lookFor": null },
    {
      "name": "Nike",
      "tier": "common",
      "lookFor": "SB Dunk, Kobe, limited Air Max, collaborations",
      "models": ["SB Dunk Low", "Air Max 90"]
    }
  ]
}
```

`name` and `tier` are all a row needs. `models` is optional. A bare array of
brand objects works too, and so does the fuller shape with an `items` array —
see *Classifying brands* below for where one of those comes from.

Rows that cannot be filed come back listed rather than dropped in silence: an
unknown tier, a brand named twice, a common brand with no `lookFor`. That last
one is filed `unsorted` instead of refused, and told to you, because a common row
that cannot say what to look for reads in an aisle as an endorsement of
everything the brand makes.

**Adding is not overwriting.** A brand already in that category keeps the tier
and description it has, however emphatically the paste disagrees, unless you tick
*Change brands already in this book*. Even then a locked brand refuses and is
counted back to you. So a paste can correct the book on purpose, and cannot
undo an afternoon of hand-sorting by accident.

Models are insert-only either way. A model struck through by hand stays struck
through however many times it is pasted again.

Nothing else writes to the book. There is no classifier, no API key and no
background job — Wheelhouse used to send every scan to a language model and file
whatever came back, and that whole path is gone.

Once brands exist, **Re-match listings** on the Report tab points every imported
sale at the brand in its title and at the model within that brand, which is where
the sold counts, medians and per-model figures come from. It runs automatically
after an import and after a paste; run it by hand after editing brands, since a
brand added today knows nothing about listings imported last month until it does.

The Report page still scores every brand against its sold prices and says where
the numbers disagree with the book, but it no longer applies anything.

**Settings** — theme (light, dark or system), the backend URL to paste into the
extension, application information, and a guarded "clear all data" action.

---

## Browser extension — Lookout

`lookout/` is the extension, and the only one. An earlier, simpler importer lived
in `browser-extension/` and was replaced by this; it was deleted rather than left
to rot, because two extensions in one repo is one too many to keep straight. See
`lookout/README.md` for how it decides what is worth sourcing, and for eBay's
crawling policy — which is worth reading before turning on page-following.

### Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `wheelhouse/lookout` folder.
5. Pin the extension so its icon is visible.
6. Set **Wheelhouse** at the bottom of the popup to wherever the server is
   running — `http://localhost:4000` by default.

Reload the extension from `chrome://extensions` after pulling; Chrome keeps
running the copy it loaded.

### Read a page

1. Start the Wheelhouse server (`cd server && npm run dev`).
2. Open eBay yourself and apply the **Sold Items** filter. Lookout reads the page
   you already have open — it does not open searches for you, because loading a
   freshly built search URL is what trips eBay's verification check.
3. Pick the **Wheelhouse category** the results belong to. This is the one
   setting worth slowing down for: the brand book is kept per category, so
   reading shoes into the shirts category does not merely mis-file rows, it
   teaches the wrong book.
4. Click **Read this page**.
5. Click **Send to Wheelhouse**.

The category dropdown is fetched live from `GET /api/ebay/categories`, so it is
whatever the database currently holds. A hardcoded copy in `popup/popup.js` is
used only when the server cannot be reached, and it is stale by definition.

Read the same page twice and everything is reported as duplicates — nothing is
stored twice.

### What the extension does and does not do

It reads the listing cards on the page you are already looking at. It does not
sign in to eBay, store eBay credentials, read or export cookies, bypass CAPTCHAs,
hide activity or attempt to evade detection.

It *can* turn pages for you, and that is off by default. With **Turn pages for
me** ticked it navigates the tab you are watching, at a jittered pace, with a
daily page budget and a 30-minute cooldown after any verification challenge.
That is automated navigation of eBay search, which their `robots.txt` prohibits
regardless of pacing — `lookout/README.md` quotes it in full. The default mode
does not navigate at all.

Permissions: `scripting`, `storage`, `tabs`, and host access to `www.ebay.com`
plus `localhost` / `127.0.0.1` so it can post to Wheelhouse.

### Duplicate handling

Each listing gets one key, in this order of preference:

1. eBay item ID → `id:<item id>`
2. Item URL with query string and fragment removed → `url:<url>`
3. Title + sold price + sold date → `fb:<title>|<price>|<date>`

The key is unique across the whole table, so re-importing a page — or importing
the same item into a different category — is recognised as a duplicate. Every
import returns `found`, `imported`, `duplicates` and `failed`, with a reason for
each failure.

### Updating the eBay parser

All eBay-specific knowledge lives in **`lookout/content/parser.js`**. Nothing
else in the extension or in Wheelhouse needs to change when eBay changes its
markup.

The file defines one strategy per page layout — current search cards
(`li.s-card`), legacy search cards (`li.s-item`), and Seller Hub Product
Research rows. Each strategy is a plain object of CSS selector arrays, tried in
order. All strategies run and the one that produces the most listings wins, so
adding a new layout cannot break the existing ones. Field lookups fall back to
scanning the card's text with regular expressions, which is why prices, sold
dates and conditions usually survive a class-name change on their own.

To update, find the comment `SELECTORS —` above the relevant block and add the
new selector to the front of the array. Leave the old selectors in place.

---

## API

All endpoints are under `/api`. Request bodies are JSON. Validation failures
return `400` with `{ "error": "Validation failed", "details": [{ "field", "message" }] }`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Liveness check |
| GET | `/api/dashboard` | Counts and lists for the dashboard |
| GET | `/api/options` | Status and type lists for the UI |
| GET | `/api/info` | Version, Node version, database path |
| DELETE | `/api/data` | Clear all business records (needs `X-Confirm-Clear: yes`) |
| GET POST | `/api/leads`, `/api/leads/:id` | `?search=`, `?status=`, `?source=` |
| PATCH DELETE | `/api/leads/:id` | |
| POST | `/api/leads/:id/convert` | Body `{ contact_type, mark_won? }` |
| GET POST | `/api/contacts` | `?search=`, `?contact_type=`, `?status=` |
| PATCH DELETE | `/api/contacts/:id` | |
| GET | `/api/contacts/:id/projects` | Projects for one contact |
| GET POST | `/api/referral-partners` | `?search=`, `?industry=` |
| PATCH DELETE | `/api/referral-partners/:id` | |
| GET POST | `/api/projects` | `?search=`, `?status=`, `?contact_id=` |
| PATCH DELETE | `/api/projects/:id` | |
| GET POST | `/api/events` | `?search=`, `?event_type=`, `?from=`, `?to=` |
| PATCH DELETE | `/api/events/:id` | |
| GET POST | `/api/notes` | `?search=`, `?contact_id=`, `?lead_id=`, `?project_id=` |
| PATCH DELETE | `/api/notes/:id` | |
| GET | `/api/ebay/categories` | The 13 seeded categories |
| GET | `/api/ebay/listings` | `?search=`, `?category=<slug>` |
| POST | `/api/ebay/import` | Body `{ category, sourceUrl?, listings[] }` |
| POST | `/api/ebay/brands/import` | Add brands from pasted JSON. Body `{ category, overwrite?, payload }` |
| POST | `/api/ebay/brands/rescore` | Re-match listings to the book, then report what the prices say |
| GET | `/api/ebay/stats` | Count, average, median, lowest, highest |
| DELETE | `/api/ebay/listings` | `?category=<slug>` to limit the scope |
| DELETE | `/api/ebay/listings/:id` | Remove one listing |

### Database tables

`leads`, `contacts`, `referral_partners`, `projects`, `events`, `notes`,
`ebay_listings` — all empty until you add something.

`ebay_brands`, `ebay_brand_models` — the brand book, pasted and corrected by you.
`ebay_brands` is unique on `(category_id, slug)` rather than on `slug` alone,
which is what keeps one book per category. Models hang off `brand_id` and inherit
their category through it. Each listing carries the `brand_id` and `model_id` it
was matched to, so a model's sold count and median come from the sales that
actually bore it.

`ebay_categories`, `option_values` — configuration, seeded at migration time.

The database runs in WAL mode. **Copying `wheelhouse.db` on its own loses
everything still in the `-wal` sidecar**, and the stale copy opens without
complaint, so back it up with `VACUUM INTO '<dest>'` or copy all three of
`wheelhouse.db`, `wheelhouse.db-wal` and `wheelhouse.db-shm`.

### eBay categories

Media: Books, DVDs, VHS Tapes.
Men: Shoes, Boots.
Women: Shoes, Boots.
Men's Clothing: Activewear, Coats/Jackets & Vests, Jeans/Pants, Shirts, Shorts,
Suits & Blazers, Sweaters, Vintage T-Shirts.
Women's Clothing: Activewear, Coats/Jackets & Vests, Dresses, Jeans/Pants,
Shorts, Skirts, Suits & Blazers, Sweaters, Tops.

Seeded on every boot. A seeded category that is no longer listed is retired
automatically, but **only when it holds no listings and no brands** — a category
with data in it is never removed.

Footwear stays under the plain `Men` / `Women` groups rather than moving to
`Men's Clothing`. The group and the name together make the slug, so renaming the
group would orphan every listing and brand already filed under `men-shoes`.

---

## Classifying brands

Wheelhouse does not classify anything. It stores what you tell it, and *Add
brands* on the Brands tab is where you tell it. Writing the JSON by hand is a
perfectly good way to use that box.

If you would rather have something else draft it, the question that used to be
sent for you is still here as text, and this prints it with a category's listings
attached:

```bash
cd server
npx tsx src/scripts/dump-prompt.ts men-shoes          # to the terminal
npx tsx src/scripts/dump-prompt.ts men-shoes > /tmp/prompt.txt   # to a file
```

The category argument is a slug (`men-shoes`, `mens-clothing-shirts`, …);
`men-shoes` is the default, and an unknown one prints the list of valid slugs.
A header line with the category and listing count goes to stderr, so the redirect
captures only the prompt.

Output is two halves joined by a `---` line: the question above it, the numbered
sold listings below. Paste the whole thing as one message wherever you like, then
paste the JSON that comes back into *Add brands*. Nothing about that round trip
touches Wheelhouse, so what you use, whether you pay for it, and whether you use
anything at all are all yours to decide.

The numbering matters only if the answer includes an `items` array. Those `i`
values point at the lines the script printed, and the import rebuilds that exact
list — priced above zero, ordered by id, one category — to read them. Import more
listings in between and they no longer line up, so paste `items` promptly or
leave it out; a paste of brand names alone still gets full figures, because
*Re-match listings* derives the per-listing attribution from titles anyway.

The prompt text lives in `server/src/lib/brand-prompt.ts` and the script imports
it, so what it prints is always the current wording. Edit it freely — nothing in
the app depends on the answer's tone, only on its shape, which
`server/src/lib/brand-paste.ts` defines.

---

## Deliberately not in this version

No AI features — Wheelhouse holds no API key, makes no model calls, and has no
background jobs. No complex automation, no advanced analytics, no opportunity
scoring, no payments, no email integration, and no third-party calendar
integration. eBay research calculates only total, average, median, lowest and
highest sold price.
