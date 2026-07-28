# Wheelhouse eBay Importer

A Chrome Manifest V3 extension that sends the eBay sold listings **already
visible on your screen** to your local Wheelhouse server.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest — permissions and popup registration |
| `popup.html` / `popup.css` / `popup.js` | The popup UI and all its logic |
| `content/parser.js` | **The only file that knows eBay's markup.** Update this when eBay changes. |
| `icons/` | Extension icons |

There is no background service worker and no declared content script, so nothing
runs unless you click the extension.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the icon → **Settings** → set the backend URL (default
   `http://localhost:4000`) → **Save backend URL**.

`localhost` and `127.0.0.1` are already permitted. Any other host asks for
permission once, via Chrome's own prompt.

## Use

1. Open an eBay sold-listings search or a Seller Hub Product Research page.
2. Scroll so the listings you care about have rendered.
3. Click the Wheelhouse icon. The popup scans the page and shows what it found.
4. Pick a Wheelhouse category.
5. **Import to Wheelhouse**.

The result panel shows found / imported / duplicates / failed, and expands to
list anything that failed validation and why.

**Rescan page** re-reads the tab — use it after scrolling or changing filters.

## Boundaries

Wheelhouse does not log into eBay, store eBay credentials, read or export
browser cookies, crawl eBay, automatically change pages, bypass CAPTCHA, hide
automated activity, or attempt to evade eBay detection. It reads the rendered
page you opened yourself, once, when you ask it to.

## Updating the parser

`content/parser.js` holds one strategy per eBay layout:

- `SEARCH_CARD` — current search results (`li.s-card` / `.su-card-container`)
- `SEARCH_ITEM` — legacy search results (`li.s-item`)
- `PRODUCT_RESEARCH` — Seller Hub Product Research rows

Every strategy runs on every scan; whichever yields the most listings is used.
That means adding or fixing one layout cannot break the others.

Each field is an array of CSS selectors tried in order, marked with a
`SELECTORS —` comment. To fix a broken field, put the new selector at the front
of its array and leave the old ones behind for older page variants.

If a selector array comes up empty, the parser falls back to scanning the whole
card's text for a price, a `Sold <date>` string, a shipping cost and a condition
keyword — so a single stale class name rarely breaks an import outright.

### If imports come back empty

The popup lists how many cards each strategy matched. If every strategy reports
`0 cards`, the container selectors need updating. Copy the outermost `<li>` for
a single sold listing from Chrome DevTools (right-click a result card →
Inspect → select the enclosing `<li>` → Copy → Copy outerHTML), along with the
opening tag of its parent `<ul>`, and update `containers` plus the field
selectors from it.
