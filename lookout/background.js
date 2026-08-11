/*
 * ============================================================================
 * Lookout — scan orchestrator
 * ============================================================================
 *
 * Drives one scan: build the sold-search URL, walk the pages, collect what is on each,
 * classify it against the Reseller Brand Guide, and send the findings to Wheelhouse.
 *
 * It runs in a real, signed-in browser session, against a live site, on the user's own
 * account. Three consequences shape everything here:
 *
 *   1. THROTTLED, ALWAYS. Pages are fetched one at a time with a deliberate pause. The
 *      cost of going faster is not a slow scan — it is a rate-limited session and a
 *      user who has to re-authenticate. There is no "turbo" setting on purpose.
 *
 *   2. STOPS ON A CHALLENGE. If eBay serves an interstitial the scan ends and says so.
 *      Retrying into a challenge is how a soft limit becomes a hard one.
 *
 *   3. RE-CHECKS ITS OWN FILTERS. Condition and price are applied by eBay in the URL,
 *      and checked again on every listing here. A URL filter that silently stops
 *      applying looks exactly like a category full of cheap new stock, and that is the
 *      failure most likely to go unnoticed.
 *
 * State lives in chrome.storage.session so the popup can close and reopen mid-scan
 * without losing the run.
 */

import { buildObservedIndex, classify, discoverCandidates, summarise } from './lib/classify.js';
import { DEFAULTS, isPreOwned, parsePrice, soldSearchUrl } from './lib/ebay-url.js';

/** Wheelhouse categories this scan knows how to search for. The terms are what goes
 *  into `_nkw`; `_sacat` stays empty until the user pins a real one. */
const SEARCH_TERMS = {
  'men-shoes': 'mens shoes',
  'men-boots': 'mens boots',
  'women-shoes': 'womens shoes',
  'women-boots': 'womens boots',
};

/* ------------------------------------------------------------------- the scan
 *
 * One scan at a time, and everything needed to stop it lives here.
 *
 * Stopping has to be immediate to be believed. The first version set a flag that the
 * page loop checked once per iteration, which meant Stop could take fifteen seconds to
 * take effect — a page load, a hydration wait, a nine-second scroll and a four-second
 * throttle all had to finish first — while the popup still read "Scanning…". That is
 * indistinguishable from a button that does nothing.
 *
 * So cancelling now does three things at once: trips the flag, wakes every pending
 * sleep, and closes the tab out from under the in-flight work so it rejects and unwinds
 * instead of running to completion.
 */
const scan = {
  active: false,
  cancelled: false,
  tabId: null,
  wakeups: new Set(),   // resolvers for sleeps that should end early on cancel

  begin(tabId) {
    this.active = true;
    this.cancelled = false;
    this.tabId = tabId;
  },
  end() {
    this.active = false;
    this.tabId = null;
    this.wakeups.clear();
  },
  cancel() {
    this.cancelled = true;
    for (const wake of this.wakeups) wake();
    this.wakeups.clear();
    // Nothing to close — the scan runs in the user's own tab. Waking every pending
    // sleep and tripping the flag is what makes Stop immediate; the checks between each
    // await do the rest.
  },
};

/* ------------------------------------------------------- not looking like a bot
 *
 * This drives a live site from a signed-in session, so the thing to avoid is not just
 * "too fast" — it is looking MECHANICAL. Perfectly even intervals are a stronger signal
 * than raw rate: no person requests a page every 4.000 seconds, forty times.
 *
 * Four defences, in rough order of how much they matter:
 *   1. jitter        every delay is randomised ±40%, here and in the page scroll
 *   2. one at a time one tab, strictly sequential, never a parallel fetch
 *   3. cooldown      a challenge blocks new scans for a while instead of retrying
 *   4. daily budget  a hard ceiling on pages per day, so an unattended loop cannot
 *                    quietly turn into a crawl
 *
 * None of this makes automated access permitted — see README. It reduces the chance of
 * tripping a limit; it does not remove it, and the account risk is the user's to accept.
 */
const COOLDOWN_AFTER_CHALLENGE_MS = 30 * 60 * 1000;
const DAILY_PAGE_BUDGET = 60;   // ~12,000 listings a day at 200 per page
const BUDGET_KEY = 'lookout.budget';
const COOLDOWN_KEY = 'lookout.cooldown';

/** ±40%, so no two waits are the same length. */
const jitter = (ms, spread = 0.4) =>
  Math.round(ms * (1 - spread + Math.random() * spread * 2));

async function checkCooldown() {
  const { [COOLDOWN_KEY]: until } = await chrome.storage.local.get(COOLDOWN_KEY);
  if (!until || Date.now() >= until) return null;
  const minutes = Math.ceil((until - Date.now()) / 60000);
  return `eBay served a verification challenge recently. Lookout is pausing for another ${minutes} minute${minutes === 1 ? '' : 's'} — running straight back into a challenge is how a soft limit becomes a hard one.`;
}

const startCooldown = () =>
  chrome.storage.local.set({ [COOLDOWN_KEY]: Date.now() + COOLDOWN_AFTER_CHALLENGE_MS });

/** Pages used today, reset on the date changing. */
async function spendBudget(pages) {
  const today = new Date().toISOString().slice(0, 10);
  const { [BUDGET_KEY]: saved } = await chrome.storage.local.get(BUDGET_KEY);
  const budget = saved?.date === today ? saved : { date: today, used: 0 };
  budget.used += pages;
  await chrome.storage.local.set({ [BUDGET_KEY]: budget });
  return budget;
}

async function remainingBudget() {
  const today = new Date().toISOString().slice(0, 10);
  const { [BUDGET_KEY]: saved } = await chrome.storage.local.get(BUDGET_KEY);
  const used = saved?.date === today ? saved.used : 0;
  return Math.max(0, DAILY_PAGE_BUDGET - used);
}

/** Sleep that ends early when the scan is cancelled. */
function sleep(ms) {
  if (scan.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      scan.wakeups.delete(finish);
      resolve();
    }
    scan.wakeups.add(finish);
  });
}

/** Thrown to unwind the scan promptly; not an error worth showing the user. */
class Cancelled extends Error {
  constructor() { super('Scan stopped'); this.name = 'Cancelled'; }
}

const throwIfCancelled = () => { if (scan.cancelled) throw new Cancelled(); };

/**
 * The brand vocabulary for a scan, built from eBay's own Brand facet.
 *
 * There is no shipped catalog any more. What a brand is worth is decided in Wheelhouse
 * by a person looking at what actually sold; the extension's only job here is to name
 * the brand correctly and count it. eBay's aspect data names it better than any list we
 * could ship, and it is already scoped to the search being run.
 *
 * Rebuilt as pages contribute new facet names — cheap, since the facet is a few dozen
 * entries rather than a few hundred catalog brands.
 */
function indexFromFacet(facet) {
  return buildObservedIndex([...facet.keys()].map((name) => ({ name })));
}

/** Verdicts that mean "a brand was identified" — the listings worth sending on. */
const IDENTIFIED = new Set(['observed', 'worthy']);

/* ---------------------------------------------------------------------- state */

const RUN_KEY = 'lookout.run';

async function setRun(patch) {
  const { [RUN_KEY]: current } = await chrome.storage.session.get(RUN_KEY);
  const next = { ...(current ?? {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [RUN_KEY]: next });
  // The popup may be closed; nobody is required to be listening.
  chrome.runtime.sendMessage({ type: 'RUN_UPDATED', run: next }).catch(() => {});
  return next;
}

async function getRun() {
  const { [RUN_KEY]: run } = await chrome.storage.session.get(RUN_KEY);
  return run ?? null;
}

/* ------------------------------------------------------------------ scan pages */

/**
 * Read one page.
 *
 * `url` null means "whatever is on screen" — the default, and the only mode that
 * involves no navigation at all. A url is passed only when the user asked Lookout to
 * follow further pages, and even then it moves the tab they are watching.
 */
async function collectPage(tabId, url) {
  throwIfCancelled();

  if (url) {
    await chrome.tabs.update(tabId, { url });
    await waitForLoad(tabId);
    throwIfCancelled();
    // eBay hydrates after load; a moment here is the difference between a full page
    // and a third of one.
    await sleep(jitter(900));
    throwIfCancelled();
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/parser.js'] });
  throwIfCancelled();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/collect.js'],
  });
  return result;
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const settle = (fn, arg) => {
      clearTimeout(timer);
      scan.wakeups.delete(onCancel);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn(arg);
    };

    const timer = setTimeout(
      () => settle(reject, new Error('Timed out waiting for the eBay page to load')),
      timeoutMs,
    );

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') settle(resolve);
    }
    // Cancelling closes the tab, which would otherwise leave this waiting the full
    // thirty seconds for a load that can never happen.
    function onRemoved(id) {
      if (id === tabId) settle(reject, new Cancelled());
    }
    function onCancel() { settle(reject, new Cancelled()); }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(onRemoved);
    scan.wakeups.add(onCancel);
  });
}

/* ----------------------------------------------------------------------- scan */

async function runScan(options) {
  if (scan.active) throw new Error('A scan is already running.');

  const {
    category,
    categoryId = '',
    minPrice = DEFAULTS.minPrice,
    maxPages = DEFAULTS.maxPages,
    usedOnly = DEFAULTS.usedOnly,
    pageDelayMs = DEFAULTS.pageDelayMs,
    follow = false,
    wheelhouseUrl = 'http://localhost:4000',
    terms: termsOverride = '',
  } = options;

  const cooling = await checkCooldown();
  if (cooling) throw new Error(cooling);

  const budgetLeft = await remainingBudget();
  if (budgetLeft <= 0) {
    throw new Error(
      `Today's page budget (${DAILY_PAGE_BUDGET}) is used up. This cap exists so an unattended run cannot turn into a crawl — it resets at midnight.`,
    );
  }
  // Reading the page on screen is the default and needs no navigation at all. Following
  // further pages drives the visible tab, at a human pace, with the user watching.
  const pageCap = follow ? Math.min(maxPages, budgetLeft) : 1;

  const terms = termsOverride || SEARCH_TERMS[category] || category.replace(/-/g, ' ');
  // Starts empty and grows from each page's Brand facet. Nothing is known before the
  // first page is read, which is the correct amount to assume about a market.
  let index = buildObservedIndex([]);

  await setRun({
    status: 'running', category, terms, page: 0, maxPages: pageCap,
    scanned: 0, worthy: 0, modelMissing: 0, unlisted: 0,
    brands: [], candidates: [], warnings: [], startedAt: Date.now(),
  });

  // THE USER'S OWN TAB, IN THE FOREGROUND. Never a background one.
  //
  // eBay's robots.txt prohibits automated access outright and disallows /sch
  // specifically, so a hidden tab walking search pages is both the likeliest thing to
  // draw a challenge and the least defensible. Reading the page already on screen is
  // ordinary use of a page the user opened; it is also the only mode where they can see
  // what is happening and stop it.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab to read.');
  if (!/^https:\/\/(www\.)?ebay\./i.test(tab.url ?? '')) {
    throw new Error('Open an eBay sold-listings page in this tab first, then scan. Use "Set up search" to get there.');
  }
  scan.begin(tab.id);

  const rows = [];
  const unlisted = [];
  const facet = new Map();
  const warnings = [];
  let signedIn = null;

  try {
    for (let page = 1; page <= pageCap; page += 1) {
      throwIfCancelled();
      await spendBudget(1);

      // page 1 is whatever is already on screen; later pages only when the user has
      // explicitly asked Lookout to follow them, and always in the tab they can see.
      const url = page === 1 ? null : soldSearchUrl({ terms, categoryId, minPrice, usedOnly, page });
      await setRun({ page, currentUrl: url ?? tab.url });

      const result = await collectPage(tab.id, url);

      if (!result?.ok) {
        if (result?.blocked === 'captcha' || result?.blocked === 'challenge') {
          // Back off for real rather than letting the user retry straight into it.
          await startCooldown();
          warnings.push(
            'eBay served a verification challenge. The scan stopped, and new scans are paused for 30 minutes — retrying into a challenge is how a soft limit becomes a hard one.',
          );
        } else {
          warnings.push(result?.error ?? 'The page could not be read.');
        }
        break;
      }

      if (signedIn === null) signedIn = result.signedIn;
      if (result.signedIn === false && page === 1) {
        warnings.push('You are not signed in to eBay. Sold results are thinner and may be capped — sign in and run again for the full picture.');
      }

      // Rebuild before classifying this page's listings, so page one's brands are
      // matchable from page one rather than a page late.
      let facetGrew = false;
      for (const item of result.brandFacet ?? []) {
        if (!facet.has(item.name)) { facet.set(item.name, item.count); facetGrew = true; }
      }
      if (facetGrew) index = indexFromFacet(facet);

      let keptThisPage = 0;
      for (const listing of result.listings) {
        const priceValue = parsePrice(listing.soldPrice);

        // Re-check what the URL already asked eBay for. A filter that silently stops
        // applying is the failure that looks like a bad market rather than a bug.
        if (minPrice > 0 && priceValue !== null && priceValue < minPrice) continue;
        if (usedOnly && isPreOwned(listing.condition) === false) continue;

        const classification = classify(index, listing);
        const row = { ...listing, priceValue, classification };
        rows.push(row);
        keptThisPage += 1;
        if (classification.verdict === 'unlisted') unlisted.push(row);
      }

      await setRun({
        scanned: rows.length,
        worthy: rows.filter((r) => IDENTIFIED.has(r.classification.verdict)).length,
        modelMissing: rows.filter((r) => r.classification.verdict === 'model-missing').length,
        unlisted: unlisted.length,
      });

      if (!result.hasNext) break;
      if (keptThisPage === 0 && page > 1) break;   // nothing usable left to walk
      // Jittered, because an interval that never varies is a stronger bot signal than
      // the rate itself.
      if (page < pageCap) await sleep(jitter(pageDelayMs));
    }
  } catch (error) {
    // Stopping on request is not a failure, and should not be reported as one.
    if (error?.name !== 'Cancelled') warnings.push(String(error?.message ?? error));
  } finally {
    // The tab belongs to the user, not to the scan. Never close it.
    scan.end();
  }

  // Whatever was collected before the stop is still worth keeping — a scan halted on
  // page four has three pages of findings, and throwing them away would make Stop feel
  // like a punishment.
  const brands = summarise(rows);
  const candidates = discoverCandidates(unlisted, { minCount: 3 });

  const run = await setRun({
    status: scan.cancelled ? 'cancelled' : 'done',
    // The listings behind the verdict, so "Send to Wheelhouse" has something to send.
    // Only the worthy ones: the whole point is not to fill the database with the
    // Nike Revolutions the guide exists to reject.
    worthyListings: rows
      .filter((r) => IDENTIFIED.has(r.classification.verdict))
      .map((r) => ({
        itemId: r.itemId, title: r.title, soldPrice: r.soldPrice,
        shippingPrice: r.shippingPrice, soldDate: r.soldDate, condition: r.condition,
        imageUrl: r.imageUrl, itemUrl: r.itemUrl,
      })),
    brands,
    candidates,
    facet: [...facet.entries()].map(([name, count]) => ({ name, count })),
    warnings,
    signedIn,
    finishedAt: Date.now(),
  });

  return run;
}

/* -------------------------------------------------------------- send to Wheelhouse */

/**
 * Send the listings to Wheelhouse.
 *
 * ONE payload, to /api/ebay/import. There was a second — a brand rollup — and removing
 * it is the fix, not a regression: see the note where it used to be sent. Brands are
 * Wheelhouse's to decide, from the listings this call delivers.
 */
async function sendToWheelhouse({ wheelhouseUrl, category }) {
  const run = await getRun();
  const listings = run?.worthyListings ?? [];
  if (!listings.length) throw new Error('Nothing worth sending — read a page first.');

  const base = wheelhouseUrl.replace(/\/$/, '');
  const slug = category ?? run.category;
  const result = { listings: null, brands: null };

  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message ?? `Wheelhouse returned ${response.status}`);
    return payload;
  };

  // Listings first: this is the part that works today.
  result.listings = await post('/api/ebay/import', {
    category: slug,
    sourceUrl: run.currentUrl,
    listings,
  });

  /* THE BRAND ROLLUP IS NOT SENT, and must not be added back.
   *
   * It used to POST to /api/ebay/brands, and what it delivered was not brands: colour
   * names, because readBrandFacet() reads every refinement list in eBay's sidebar and
   * not only the Brand one, plus the leading words of unmatched titles — "air",
   * "nike air", "jordan retro" — which are fragments of a model. Sixteen such rows
   * reached Wheelhouse's brand book and were the first thing shown under Unsorted.
   *
   * Wheelhouse's brand book is written by its user, by hand or by pasting a block of
   * classified brands into it. Nothing this end guesses belongs in there. This end sends
   * listings. That is the whole contract. */

  await setRun({ sent: { at: Date.now(), ...result } });
  return result;
}

/* -------------------------------------------------------------------- messaging */

function handle(message, sendResponse) {
  const done = (promise) => {
    promise.then(
      (data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
    );
    return true;
  };

  switch (message?.type) {
    case 'GET_RUN':
      // Flag a run that storage thinks is live but this worker is not running, so the
      // popup can offer a way out instead of showing a permanent "Scanning…".
      return done(
        getRun().then((run) =>
          run && (run.status === 'running' || run.status === 'cancelling') && !scan.active
            ? { ...run, stale: true }
            : run,
        ),
      );
    case 'START_SCAN':
      return done(runScan(message.options ?? {}));
    /* Navigate the tab the user is looking at to the right search, then leave them
       there. They see the page, the filters and the result count before anything reads
       it — and they can refine it themselves first. */
    /* SET_UP_SEARCH is deliberately absent. It navigated the active tab to a built
       sold-search URL, which is the one thing here eBay reliably answered with a
       verification check. The user opens the page; Lookout reads it. */

    case 'CANCEL_SCAN':
      scan.cancel();
      return done(setRun({ status: 'cancelling' }));

    /* A service worker can be shut down mid-scan, which orphans the run: storage still
       says "running" but nothing is left alive to finish or stop it, so the popup shows
       a scan that can never be cancelled. Nothing can rescue that run, but the user must
       be able to get out of it. */
    case 'RESET':
      scan.cancel();
      scan.end();
      return done(setRun({ status: 'cancelled', warnings: ['Scan reset.'] }));
    case 'SEND_TO_WHEELHOUSE':
      return done(sendToWheelhouse(message.options ?? {}));
    default:
      sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handle(message, sendResponse));

/* The Wheelhouse page's "Open eBay" button talks to the extension through here, so the
   button can start a scan instead of dumping the user on a raw eBay search. Restricted
   to the origins in externally_connectable. */
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) =>
  handle(message, sendResponse),
);
