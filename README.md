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
  browser-extension/  Chrome Manifest V3 extension that imports eBay listings
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

**Settings** — theme (light, dark or system), the backend URL to paste into the
extension, application information, and a guarded "clear all data" action.

---

## Browser extension

### Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `wheelhouse/browser-extension` folder.
5. Pin the extension so its icon is visible.
6. Click the icon, open **Settings** inside the popup, and set the backend URL
   to wherever the Wheelhouse server is running — `http://localhost:4000` by
   default. `localhost` and `127.0.0.1` are pre-authorised; any other address
   triggers a one-time Chrome permission prompt.

### Test an import

1. Start the Wheelhouse server (`cd server && npm run dev`).
2. In Wheelhouse, open **eBay Research**, pick a category, type something to
   search for, and click **Open eBay**. (Or browse eBay yourself and apply the
   **Sold Items** filter.)
3. Wait for the results to render, and scroll so the listings you want are
   loaded — the extension reads what is on the page.
4. Click the Wheelhouse extension icon. The popup reports how many listings it
   found and which layout it recognised.
5. Choose a Wheelhouse category and click **Import to Wheelhouse**.
6. The popup shows found / imported / duplicates / failed, and lists anything
   that failed validation.
7. Back in Wheelhouse, refresh the eBay Research page to see the listings and
   the price statistics.

Import the same page twice and everything is reported as duplicates — nothing is
stored twice.

### What the extension does and does not do

It reads the listing cards on the page you are already looking at, only when you
click it. It does not sign in to eBay, store eBay credentials, read or export
cookies, crawl eBay, change pages, bypass CAPTCHAs, hide activity or attempt to
evade detection. It has no background page and no automatic scanning.

Permissions: `activeTab` (read the current tab, granted only when you click the
extension), `scripting`, `storage`, and host access to `localhost` /
`127.0.0.1` so the popup can post to Wheelhouse.

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

All eBay-specific knowledge lives in **`browser-extension/content/parser.js`**.
Nothing else in the extension or in Wheelhouse needs to change when eBay changes
its markup.

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
| GET | `/api/ebay/stats` | Count, average, median, lowest, highest |
| DELETE | `/api/ebay/listings` | `?category=<slug>` to limit the scope |
| DELETE | `/api/ebay/listings/:id` | Remove one listing |

### Database tables

`leads`, `contacts`, `referral_partners`, `projects`, `events`, `notes`,
`ebay_listings` — all empty until you add something.

`ebay_categories`, `option_values` — configuration, seeded at migration time.

### eBay categories

Media: Books, DVDs, VHS Tapes.
Men: Shirts, Jeans, Jackets, Shoes, Boots.
Women: Shirts, Jeans, Jackets, Shoes, Boots.

---

## Deliberately not in this version

No AI features, no complex automation, no advanced analytics, no opportunity
scoring, no payments, no email integration, and no third-party calendar
integration. eBay research calculates only total, average, median, lowest and
highest sold price.
