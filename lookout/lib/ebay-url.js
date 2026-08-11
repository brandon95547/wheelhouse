/*
 * The eBay sold-search URL, in one place.
 *
 * Every filter the scan depends on is a query parameter, so this file is the whole
 * contract with eBay's search: change a rule here and the entire scan changes. Keeping
 * them as named constants rather than inline strings is the difference between "why is
 * it returning new items" and one obvious line.
 *
 * The filters do the coarse work SERVER-SIDE — condition, price floor, sold-only — so a
 * page of 200 is 200 candidates rather than 200 rows to throw away. The classifier then
 * does the part eBay cannot: worthy brand or not. Both still get re-checked on the
 * client in background.js, because a filter silently not applying is otherwise
 * indistinguishable from a category with nothing good in it.
 */

export const EBAY_PARAMS = {
  /** Sold, and completed. Both, because "sold" alone still shows active listings on
      some layouts. */
  sold: { LH_Sold: '1', LH_Complete: '1' },
  /** eBay's condition id for Used / Pre-owned. */
  usedCondition: { LH_ItemCondition: '3000' },
  /** Results per page. 200 is eBay's maximum and the reason a scan is a handful of
      page loads rather than dozens. */
  perPage: '200',
};

export const DEFAULTS = {
  minPrice: 40,
  perPage: 200,
  maxPages: 5,
  /** Milliseconds between page loads. Deliberately unhurried: this drives a real
      browser session against a live site, and a scan that trips rate limiting returns
      nothing and costs the user their session. */
  pageDelayMs: 4000,
  usedOnly: true,
};

/**
 * Build one page of an eBay sold search.
 *
 * `categoryId` is eBay's own `_sacat`. It is optional and empty by default — the
 * catalog ships search TERMS, not category ids, because an id typed from memory that
 * turns out to be wrong scans the wrong category and reports "nothing found", which
 * reads like an empty market rather than a bug. Pin a real one from the popup and it
 * gets used from then on.
 */
export function soldSearchUrl({
  terms,
  categoryId = '',
  minPrice = DEFAULTS.minPrice,
  usedOnly = DEFAULTS.usedOnly,
  perPage = DEFAULTS.perPage,
  page = 1,
} = {}) {
  const params = new URLSearchParams({
    _nkw: String(terms ?? '').trim(),
    ...EBAY_PARAMS.sold,
    _ipg: String(perPage),
    _pgn: String(page),
  });

  if (usedOnly) for (const [k, v] of Object.entries(EBAY_PARAMS.usedCondition)) params.set(k, v);
  if (minPrice > 0) params.set('_udlo', String(minPrice));
  if (categoryId) params.set('_sacat', String(categoryId));

  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

/** Pull `_sacat` out of whatever eBay page the user is looking at, for "pin category". */
export function categoryIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)ebay\./i.test(parsed.hostname)) return null;
    const sacat = parsed.searchParams.get('_sacat');
    if (sacat && /^\d+$/.test(sacat) && sacat !== '0') return sacat;
    // Category browse pages carry the id in the path: /b/Mens-Shoes/93427/bn_16givnq
    const path = parsed.pathname.match(/\/b\/[^/]+\/(\d{2,10})\b/);
    return path ? path[1] : null;
  } catch {
    return null;
  }
}

/** Money out of "US $124.99", "$1,250.00", "£89.00". Null when there is no number. */
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const match = String(raw ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** Did eBay actually give us pre-owned? The parser reports the card's own wording. */
export function isPreOwned(condition) {
  if (!condition) return null; // unknown, not "no"
  return /pre-?owned|used|very good|good|acceptable/i.test(condition);
}
