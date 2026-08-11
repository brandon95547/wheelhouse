/*
 * Popup — the scan's controls and its results.
 *
 * Holds no scan logic. The service worker owns the run and its state, because a popup is
 * dismissed the moment the user clicks anywhere else, and a scan that dies with its
 * window would be unusable. Everything here reads state and sends intents.
 */
import { categoryIdFromUrl } from '../lib/ebay-url.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'lookout.settings';
const PINS_KEY = 'lookout.pins';

const send = (type, options) =>
  chrome.runtime.sendMessage({ type, options }).then((reply) => {
    if (!reply?.ok) throw new Error(reply?.error ?? 'The extension did not respond.');
    return reply.data;
  });

const money = (value) =>
  typeof value === 'number' ? `$${value.toFixed(2).replace(/\.00$/, '')}` : '—';

/* ------------------------------------------------------------------- settings */

/* Where a read lands in Wheelhouse.
 *
 * ASKED FOR, NOT HARDCODED. This list used to be two entries maintained by hand, and it
 * silently stopped matching the moment Wheelhouse gained categories — the dropdown kept
 * offering shoes while the app had twenty-four, and nothing anywhere said so. Wheelhouse
 * is the authority on its own categories, so the popup asks it.
 *
 * The slug must match a seeded Wheelhouse category; the import rejects anything else by
 * name, which is the behaviour you want when these drift apart.
 *
 * A category is now more than a label on a listing: the brand book is kept PER CATEGORY,
 * so reading shoes into the shirts category does not merely mis-file rows, it teaches the
 * wrong book.
 */
const FALLBACK_CATEGORIES = [
  { slug: 'media-books', group: 'Media', name: 'Books' },
  { slug: 'media-dvds', group: 'Media', name: 'DVDs' },
  { slug: 'media-vhs-tapes', group: 'Media', name: 'VHS Tapes' },
  { slug: 'men-shoes', group: 'Men', name: 'Shoes' },
  { slug: 'men-boots', group: 'Men', name: 'Boots' },
  { slug: 'women-shoes', group: 'Women', name: 'Shoes' },
  { slug: 'women-boots', group: 'Women', name: 'Boots' },
  { slug: 'mens-clothing-activewear', group: "Men's Clothing", name: 'Activewear' },
  { slug: 'mens-clothing-coats-jackets-vests', group: "Men's Clothing", name: 'Coats, Jackets & Vests' },
  { slug: 'mens-clothing-jeans-pants', group: "Men's Clothing", name: 'Jeans, Pants' },
  { slug: 'mens-clothing-shirts', group: "Men's Clothing", name: 'Shirts' },
  { slug: 'mens-clothing-shorts', group: "Men's Clothing", name: 'Shorts' },
  { slug: 'mens-clothing-suits-blazers', group: "Men's Clothing", name: 'Suits & Blazers' },
  { slug: 'mens-clothing-sweaters', group: "Men's Clothing", name: 'Sweaters' },
  { slug: 'mens-clothing-vintage-t-shirts', group: "Men's Clothing", name: 'Vintage T-Shirts' },
  { slug: 'womens-clothing-activewear', group: "Women's Clothing", name: 'Activewear' },
  { slug: 'womens-clothing-coats-jackets-vests', group: "Women's Clothing", name: 'Coats, Jackets & Vests' },
  { slug: 'womens-clothing-dresses', group: "Women's Clothing", name: 'Dresses' },
  { slug: 'womens-clothing-jeans-pants', group: "Women's Clothing", name: 'Jeans, Pants' },
  { slug: 'womens-clothing-shorts', group: "Women's Clothing", name: 'Shorts' },
  { slug: 'womens-clothing-skirts', group: "Women's Clothing", name: 'Skirts' },
  { slug: 'womens-clothing-suits-blazers', group: "Women's Clothing", name: 'Suits & Blazers' },
  { slug: 'womens-clothing-sweaters', group: "Women's Clothing", name: 'Sweaters' },
  { slug: 'womens-clothing-tops', group: "Women's Clothing", name: 'Tops' },
];

/* Category names carry "&" and apostrophes — "Coats, Jackets & Vests", "Men's Clothing" —
   so both the option text and the optgroup label go through escapeHtml, defined below. */
function renderCategories(categories) {
  const groups = new Map();
  for (const c of categories) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  $('category').innerHTML = [...groups]
    .map(
      ([group, items]) =>
        `<optgroup label="${escapeHtml(group)}">${items
          .map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');
}

/**
 * Read the categories Wheelhouse actually has.
 *
 * Falls back to the list above when Wheelhouse is unreachable, so the popup still works
 * offline — but the fallback is a stale copy by definition, which is why it is only ever
 * reached on a failed request.
 */
async function loadCategories(wheelhouseUrl) {
  const base = String(wheelhouseUrl ?? '').trim().replace(/\/$/, '');
  if (base) {
    try {
      const response = await fetch(`${base}/api/ebay/categories`);
      if (response.ok) {
        const rows = await response.json();
        if (Array.isArray(rows) && rows.length) {
          renderCategories(
            rows.map((r) => ({ slug: r.slug, group: r.group_name, name: r.name })),
          );
          return;
        }
      }
    } catch {
      /* Offline or the server is down. The fallback below is the whole point. */
    }
  }
  renderCategories(FALLBACK_CATEGORIES);
}

async function loadSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  const s = saved ?? {};
  // The URL has to be restored BEFORE the categories are fetched — they come from it.
  if (s.wheelhouseUrl) $('wheelhouseUrl').value = s.wheelhouseUrl;
  await loadCategories($('wheelhouseUrl').value);

  /* Restore the remembered category, and say so when it is gone. Assigning a slug no
     option carries leaves the select on whatever is first, which would silently read the
     page into the wrong category — the one mistake this dropdown must not make. */
  if (s.category) {
    $('category').value = s.category;
    if ($('category').value !== s.category) {
      $('category').selectedIndex = -1;
      $('warnings').hidden = false;
      $('warnings').innerHTML =
        `<p>The category you last read into (${escapeHtml(s.category)}) no longer exists in ` +
        'Wheelhouse. Pick another before reading a page.</p>';
    }
  }
  if (s.terms) $('terms').value = s.terms;
  if (s.minPrice != null) $('minPrice').value = s.minPrice;
  if (s.maxPages != null) $('maxPages').value = s.maxPages;
  if (s.usedOnly != null) $('usedOnly').checked = s.usedOnly;
  if (s.follow != null) $('follow').checked = s.follow;
  await renderPin();
}

function currentSettings() {
  return {
    category: $('category').value,
    terms: $('terms').value.trim(),
    minPrice: Number($('minPrice').value) || 0,
    maxPages: Math.max(1, Number($('maxPages').value) || 1),
    usedOnly: $('usedOnly').checked,
    follow: $('follow').checked,
    wheelhouseUrl: $('wheelhouseUrl').value.trim(),
  };
}

const saveSettings = () =>
  chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings() });

/* ------------------------------------------------------------- pinned category */

async function getPins() {
  const { [PINS_KEY]: pins } = await chrome.storage.local.get(PINS_KEY);
  return pins ?? {};
}

async function renderPin() {
  const pins = await getPins();
  const id = pins[$('category').value];
  $('pinState').textContent = id
    ? `Pinned to eBay category ${id}.`
    : 'No eBay category pinned — searching by keyword.';
}

$('pin').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = categoryIdFromUrl(tab?.url ?? '');
  if (!id) {
    $('pinState').textContent = 'That tab has no eBay category id in its URL.';
    return;
  }
  const pins = await getPins();
  pins[$('category').value] = id;
  await chrome.storage.local.set({ [PINS_KEY]: pins });
  await renderPin();
});

/* --------------------------------------------------------------------- render */

function renderRun(run) {
  if (!run) return;
  const stopping = run.status === 'cancelling';
  const running = run.status === 'running' || stopping;

  // A run storage still calls live, with nothing running it. Nothing can finish it, so
  // the only useful thing to offer is a way out.
  if (run.stale) {
    $('progress').hidden = false;
    $('scan').disabled = false;
    $('scan').textContent = 'Read this page';
    $('cancel').hidden = false;
    $('cancel').textContent = 'Reset';
    $('cancel').disabled = false;
    $('barFill').style.width = '100%';
    $('progressText').textContent =
      'This scan was interrupted — Chrome shut the extension down while it was running. Reset to start again.';
    return;
  }

  $('progress').hidden = !run.status;
  $('scan').disabled = running;
  $('scan').textContent = running ? 'Reading…' : ($('follow').checked ? 'Read & follow' : 'Read this page');
  $('cancel').hidden = !running;
  $('cancel').textContent = stopping ? 'Stopping…' : 'Stop';
  $('cancel').disabled = stopping;

  const pct = run.maxPages ? Math.min(100, Math.round((run.page / run.maxPages) * 100)) : 0;
  $('barFill').style.width = `${running ? pct : 100}%`;
  $('progressText').textContent = stopping
    ? 'Stopping — finishing the current page…'
    : running
      ? `Page ${run.page} of ${run.maxPages} · ${run.scanned ?? 0} listings read`
      : `${run.status === 'cancelled' ? 'Stopped' : 'Finished'} · ${run.scanned ?? 0} listings across ${run.page} page${run.page === 1 ? '' : 's'}`;

  $('tallyWorthy').textContent = run.worthy ?? 0;
  $('tallyMissing').textContent = run.modelMissing ?? 0;
  $('tallyUnlisted').textContent = run.unlisted ?? 0;

  const warnings = run.warnings ?? [];
  $('warnings').hidden = !warnings.length;
  $('warnings').innerHTML = warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join('');

  const brands = run.brands ?? [];
  $('results').hidden = running || !brands.length;
  $('brandList').innerHTML = brands.map(brandRow).join('');

  const candidates = run.candidates ?? [];
  $('candidatesBox').hidden = !candidates.length;
  $('candidateCount').textContent = candidates.length ? `(${candidates.length})` : '';
  $('candidateList').innerHTML = candidates
    .slice(0, 30)
    .map(
      (c) => `<li><div class="brand-top"><span class="brand-name">${escapeHtml(c.name)}</span>
        <span class="brand-price">${money(c.medianPrice)}</span></div>
        <div class="brand-meta">${c.count} sold in this scan</div></li>`,
    )
    .join('');

  if (run.sent) {
    $('send').textContent = `Sent · ${run.sent.saved ?? ''}`.trim();
  }
}

function brandRow(b) {
  const models = b.models.slice(0, 4).map((m) => `<span class="tag">${escapeHtml(m.name)} ×${m.count}</span>`).join('');
  const signals = (b.signals ?? []).map((s) => `<span class="tag">${escapeHtml(s)}</span>`).join('');
  const tier = b.tier === 'master'
    ? '<span class="tag tag-master">on sight</span>'
    : '<span class="tag">model</span>';
  const rejected = b.rejectedCount
    ? ` · ${b.rejectedCount} wrong model` : '';
  return `<li>
    <div class="brand-top">
      <span class="brand-name">${escapeHtml(b.brand)}</span>
      <span class="brand-price">${money(b.medianPrice)}</span>
    </div>
    <div class="brand-meta">${b.soldCount} sold${rejected} · high ${money(b.highPrice)}</div>
    <div>${tier}${models}${signals}</div>
  </li>`;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --------------------------------------------------------------------- wiring */

$('scan').addEventListener('click', async () => {
  await saveSettings();
  const settings = currentSettings();
  const pins = await getPins();
  $('warnings').hidden = true;
  try {
    renderRun(await send('START_SCAN', { ...settings, categoryId: pins[settings.category] ?? '' }));
  } catch (error) {
    $('warnings').hidden = false;
    $('warnings').innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    $('scan').disabled = false;
    $('scan').textContent = $('follow').checked ? 'Read & follow' : 'Read this page';
  }
});

/* THERE IS NO "OPEN THE SEARCH" STEP, and that is the point.
 *
 * Four buttons here used to build a sold-search URL and navigate the tab to it. Loading
 * a freshly constructed search is what eBay reads as automation, so every click had a
 * decent chance of landing on a verification check instead of results — for a page the
 * user was usually already looking at.
 *
 * The category above is now only a destination: which Wheelhouse category the listings
 * on screen belong to. Getting the right page on screen is the user's job, done in the
 * browser like any other browsing, which is exactly the interaction eBay does not
 * object to. */

$('cancel').addEventListener('click', () =>
  send(document.getElementById('cancel').textContent === 'Reset' ? 'RESET' : 'CANCEL_SCAN')
    .then(renderRun)
    .catch(() => {}));

$('send').addEventListener('click', async () => {
  const settings = currentSettings();
  $('send').disabled = true;
  $('send').textContent = 'Sending…';
  try {
    const result = await send('SEND_TO_WHEELHOUSE', {
      wheelhouseUrl: settings.wheelhouseUrl,
      category: settings.category,
    });
    const imported = result.listings?.imported ?? 0;
    const dupes = result.listings?.duplicates ?? 0;
    $('send').textContent = `Sent ${imported}`;
    if (dupes) {
      $('warnings').hidden = false;
      $('warnings').innerHTML =
        `<p>${imported} listing${imported === 1 ? '' : 's'} imported, ${dupes} already there.</p>` +
        '<p>Wheelhouse is classifying the brands now — they appear in its Brands tab, not here.</p>';
    }
  } catch (error) {
    $('send').textContent = 'Send to Wheelhouse';
    $('send').disabled = false;
    $('warnings').hidden = false;
    $('warnings').innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

for (const id of ['category', 'terms', 'minPrice', 'maxPages', 'usedOnly', 'follow', 'wheelhouseUrl']) {
  $(id).addEventListener('change', async () => {
    saveSettings();
    if (id === 'category') renderPin();
    /* Point Lookout at a different Wheelhouse and the categories come from that one. The
       remembered selection is re-applied after, since the new instance may not have it. */
    if (id === 'wheelhouseUrl') {
      const previous = $('category').value;
      await loadCategories($('wheelhouseUrl').value);
      $('category').value = previous;
      if ($('category').value !== previous) $('category').selectedIndex = -1;
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'RUN_UPDATED') renderRun(message.run);
});

loadSettings()
  .then(() => send('GET_RUN'))
  .then(renderRun)
  .catch(() => {});
