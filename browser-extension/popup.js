/*
 * Wheelhouse extension popup.
 *
 * Everything here happens because the user clicked the extension. Opening the
 * popup reads the listings already rendered on the current tab; nothing is
 * sent anywhere until the Import button is pressed. The extension never signs
 * in to eBay, never reads cookies, and never navigates or scans in the
 * background.
 */

'use strict';

const DEFAULT_BACKEND_URL = 'http://localhost:4000';

/** Used only if the backend cannot be reached; matches the seeded categories. */
const FALLBACK_CATEGORIES = [
  { slug: 'media-books', group_name: 'Media', name: 'Books' },
  { slug: 'media-dvds', group_name: 'Media', name: 'DVDs' },
  { slug: 'media-vhs-tapes', group_name: 'Media', name: 'VHS Tapes' },
  { slug: 'men-shirts', group_name: 'Men', name: 'Shirts' },
  { slug: 'men-jeans', group_name: 'Men', name: 'Jeans' },
  { slug: 'men-jackets', group_name: 'Men', name: 'Jackets' },
  { slug: 'men-shoes', group_name: 'Men', name: 'Shoes' },
  { slug: 'men-boots', group_name: 'Men', name: 'Boots' },
  { slug: 'women-shirts', group_name: 'Women', name: 'Shirts' },
  { slug: 'women-jeans', group_name: 'Women', name: 'Jeans' },
  { slug: 'women-jackets', group_name: 'Women', name: 'Jackets' },
  { slug: 'women-shoes', group_name: 'Women', name: 'Shoes' },
  { slug: 'women-boots', group_name: 'Women', name: 'Boots' },
];

const el = (id) => document.getElementById(id);

const ui = {
  settingsToggle: el('settings-toggle'),
  settingsPanel: el('settings-panel'),
  backendUrl: el('backend-url'),
  saveSettings: el('save-settings'),
  pageStatus: el('page-status'),
  pageDetail: el('page-detail'),
  importPanel: el('import-panel'),
  category: el('category'),
  rescan: el('rescan'),
  importButton: el('import'),
  resultPanel: el('result-panel'),
  resultMessage: el('result-message'),
  resultStats: el('result-stats'),
  statFound: el('stat-found'),
  statImported: el('stat-imported'),
  statDuplicates: el('stat-duplicates'),
  statFailed: el('stat-failed'),
  resultErrors: el('result-errors'),
  errorList: el('error-list'),
  openEbay: el('open-ebay'),
  parserVersion: el('parser-version'),
};

let state = {
  backendUrl: DEFAULT_BACKEND_URL,
  tab: null,
  scan: null,
};

/* --------------------------------------------------------------- helpers */

function setStatus(node, message, tone = 'neutral') {
  node.textContent = message;
  node.className = `status status-${tone}`;
  node.hidden = false;
}

function showResult(message, tone) {
  ui.resultPanel.hidden = false;
  setStatus(ui.resultMessage, message, tone);
}

function normaliseUrl(raw) {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BACKEND_URL;
  try {
    return new URL(trimmed).origin + new URL(trimmed).pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Chrome needs explicit permission before the popup can call a custom host. */
async function ensureHostPermission(url) {
  const origin = `${new URL(url).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- settings */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(['backendUrl', 'lastCategory']);
  state.backendUrl = stored.backendUrl || DEFAULT_BACKEND_URL;
  state.lastCategory = stored.lastCategory || '';
  ui.backendUrl.value = state.backendUrl;
}

async function saveSettings() {
  const normalised = normaliseUrl(ui.backendUrl.value);
  if (!normalised) {
    showResult('That backend URL is not valid. Use something like http://localhost:4000', 'error');
    return;
  }

  const granted = await ensureHostPermission(normalised);
  if (!granted) {
    showResult('Permission to contact that address was declined.', 'error');
    return;
  }

  state.backendUrl = normalised;
  ui.backendUrl.value = normalised;
  await chrome.storage.sync.set({ backendUrl: normalised });
  showResult('Backend URL saved.', 'ok');
  await loadCategories();
}

/* ------------------------------------------------------------ categories */

function renderCategories(categories) {
  const groups = new Map();
  for (const category of categories) {
    if (!groups.has(category.group_name)) groups.set(category.group_name, []);
    groups.get(category.group_name).push(category);
  }

  ui.category.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— Choose a category —';
  ui.category.append(placeholder);

  for (const [groupName, items] of groups) {
    const group = document.createElement('optgroup');
    group.label = groupName;
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.slug;
      option.textContent = item.name;
      group.append(option);
    }
    ui.category.append(group);
  }

  if (state.lastCategory) ui.category.value = state.lastCategory;
}

async function loadCategories() {
  try {
    const response = await fetch(`${state.backendUrl}/api/ebay/categories`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCategories(await response.json());
  } catch {
    renderCategories(FALLBACK_CATEGORIES);
    showResult(
      `Could not reach Wheelhouse at ${state.backendUrl}. Using the default category list — check the server is running before importing.`,
      'warn',
    );
  }
}

/* ------------------------------------------------------------------ scan */

async function scanActiveTab() {
  ui.importButton.disabled = true;
  ui.resultPanel.hidden = true;
  setStatus(ui.pageStatus, 'Reading the listings on this page…', 'neutral');
  ui.pageDetail.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;

  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    setStatus(ui.pageStatus, 'Open an eBay results page in this tab first.', 'warn');
    ui.importPanel.hidden = true;
    return;
  }

  let hostname = '';
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    hostname = '';
  }

  if (!/(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(hostname)) {
    setStatus(
      ui.pageStatus,
      'This tab is not an eBay page. Open an eBay sold-listings or Product Research page, then click the extension again.',
      'warn',
    );
    ui.importPanel.hidden = true;
    return;
  }

  try {
    // Two injections into the same isolated world: the parser defines itself,
    // then a tiny function calls it and hands the result back to the popup.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/parser.js'],
    });

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.WheelhouseParser.extractAll(),
    });

    state.scan = injection?.result ?? null;
  } catch (error) {
    setStatus(
      ui.pageStatus,
      `Could not read this page: ${error?.message ?? error}. Try reloading the eBay tab.`,
      'error',
    );
    ui.importPanel.hidden = true;
    return;
  }

  const scan = state.scan;
  if (!scan) {
    setStatus(ui.pageStatus, 'No response from the page. Try reloading the eBay tab.', 'error');
    ui.importPanel.hidden = true;
    return;
  }

  ui.parserVersion.textContent = `Parser v${scan.parserVersion}`;
  ui.importPanel.hidden = false;

  if (scan.found === 0) {
    setStatus(
      ui.pageStatus,
      'No listings found on this page. Scroll the results into view, or check that sold listings are showing, then click Rescan.',
      'warn',
    );
    const worstCase = scan.diagnostics
      .map((d) => `${d.strategy}: ${d.cardsFound} cards`)
      .join(' · ');
    ui.pageDetail.textContent = `Layouts checked — ${worstCase}`;
    ui.pageDetail.hidden = false;
    return;
  }

  const plural = scan.found === 1 ? 'listing' : 'listings';
  setStatus(ui.pageStatus, `${scan.found} ${plural} found on this page.`, 'ok');

  const withDate = scan.listings.filter((l) => l.soldDate).length;
  const withId = scan.listings.filter((l) => l.itemId).length;
  ui.pageDetail.textContent =
    `Layout: ${scan.strategyLabel}. ${withId} with an item ID, ${withDate} with a sold date.` +
    (scan.page.kind === 'search' && !scan.page.soldFilter
      ? ' This looks like an active-listing search — add the Sold Items filter for sold prices.'
      : '');
  ui.pageDetail.hidden = false;

  ui.importButton.disabled = false;
}

/* ---------------------------------------------------------------- import */

async function importListings() {
  const category = ui.category.value;
  if (!category) {
    showResult('Choose a Wheelhouse category first.', 'warn');
    ui.category.focus();
    return;
  }
  if (!state.scan || !state.scan.listings.length) {
    showResult('Nothing to import. Click Rescan page first.', 'warn');
    return;
  }

  ui.importButton.disabled = true;
  ui.importButton.textContent = 'Importing…';
  await chrome.storage.sync.set({ lastCategory: category });

  try {
    const response = await fetch(`${state.backendUrl}/api/ebay/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category,
        sourceUrl: state.tab?.url ?? null,
        listings: state.scan.listings,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const detail =
        payload?.details?.map((d) => d.message).join(' ') ??
        payload?.message ??
        payload?.error ??
        `HTTP ${response.status}`;
      showResult(`Import failed: ${detail}`, 'error');
      return;
    }

    ui.statFound.textContent = payload.found;
    ui.statImported.textContent = payload.imported;
    ui.statDuplicates.textContent = payload.duplicates;
    ui.statFailed.textContent = payload.failed;
    ui.resultStats.hidden = false;

    ui.errorList.textContent = '';
    if (payload.errors?.length) {
      for (const error of payload.errors) {
        const item = document.createElement('li');
        item.textContent = `${error.title} — ${error.reason}`;
        ui.errorList.append(item);
      }
      ui.resultErrors.hidden = false;
    } else {
      ui.resultErrors.hidden = true;
    }

    showResult(payload.message, payload.imported > 0 ? 'ok' : 'warn');
  } catch (error) {
    showResult(
      `Could not reach Wheelhouse at ${state.backendUrl}. Check the server is running and the backend URL is correct. (${error?.message ?? error})`,
      'error',
    );
  } finally {
    ui.importButton.disabled = false;
    ui.importButton.textContent = 'Import to Wheelhouse';
  }
}

/* ----------------------------------------------------------------- start */

ui.settingsToggle.addEventListener('click', () => {
  const open = ui.settingsPanel.hidden;
  ui.settingsPanel.hidden = !open;
  ui.settingsToggle.setAttribute('aria-expanded', String(open));
});

ui.saveSettings.addEventListener('click', saveSettings);
ui.rescan.addEventListener('click', scanActiveTab);
ui.importButton.addEventListener('click', importListings);

ui.openEbay.addEventListener('click', () => {
  chrome.tabs.create({
    url: 'https://www.ebay.com/sch/i.html?_nkw=&LH_Sold=1&LH_Complete=1',
  });
});

(async function init() {
  await loadSettings();
  await Promise.all([loadCategories(), scanActiveTab()]);
})();
