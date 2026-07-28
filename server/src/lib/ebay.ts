/**
 * Normalisation helpers for listings sent by the Wheelhouse browser extension.
 *
 * The extension does its best to clean values before sending them, but page
 * markup changes, so the server re-parses everything defensively and never
 * trusts the shape of the payload.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Pulls the first monetary amount out of a string. Returns null if absent. */
export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;
  // "Free shipping", "Free delivery" and similar all mean zero.
  if (/^free\b/i.test(text)) return 0;

  // Strip currency symbols/codes, then take the first number. Handles both
  // "1,234.56" (comma thousands) and "1.234,56" (European formatting).
  const match = text.replace(/[^\d.,\s-]/g, ' ').match(/-?\d[\d.,]*/);
  if (!match) return null;

  let digits = match[0];
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma > lastDot) {
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/,/g, '');
  }

  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Accepts the date formats eBay renders on sold listings and returns
 * YYYY-MM-DD, or null when nothing usable is present.
 */
export function parseSoldDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^\s*sold\s*/i, '').trim();
  if (!text) return null;

  // Already ISO, possibly with a time component.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // "Jul 14, 2026" / "Jul-14-2026" / "Jul 14 2026"
  const monthFirst = text.match(/^([A-Za-z]{3,})[\s.-]+(\d{1,2})[\s,.-]+(\d{4})/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (month) return toIso(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  // "14 Jul 2026"
  const dayFirst = text.match(/^(\d{1,2})[\s.-]+([A-Za-z]{3,})[\s,.-]+(\d{4})/);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (month) return toIso(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  // "07/14/2026" — eBay's US locale renders month first.
  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (numeric) {
    const year = Number(numeric[3]);
    return toIso(year < 100 ? 2000 + year : year, Number(numeric[1]), Number(numeric[2]));
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1990 || year > 2999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Only http(s) URLs are stored, so nothing odd ends up in an href or img src. */
export function sanitiseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

/** eBay item URLs look like /itm/1234567890 or /itm/some-slug/1234567890. */
export function extractItemId(itemId: unknown, itemUrl: string | null): string | null {
  if (typeof itemId === 'string' || typeof itemId === 'number') {
    const cleaned = String(itemId).trim().replace(/\D/g, '');
    if (cleaned.length >= 9 && cleaned.length <= 15) return cleaned;
  }
  if (itemUrl) {
    const match = itemUrl.match(/\/itm\/(?:[^/?#]*\/)?(\d{9,15})/);
    if (match) return match[1];
  }
  return null;
}

/** Drops tracking parameters so the same item always yields the same key. */
export function canonicalItemUrl(itemUrl: string | null): string | null {
  if (!itemUrl) return null;
  try {
    const url = new URL(itemUrl);
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

export interface NormalisedListing {
  item_id: string | null;
  title: string;
  sold_price: number;
  shipping_price: number | null;
  total_price: number;
  sold_date: string | null;
  condition: string | null;
  image_url: string | null;
  item_url: string | null;
  dedupe_key: string;
}

export interface ListingProblem {
  index: number;
  title: string;
  reason: string;
}

const str = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/**
 * Validates and normalises one raw listing.
 *
 * The duplicate key is layered exactly as specified: eBay item id first, then
 * the canonical item URL, then a title + price + date fingerprint.
 */
export function normaliseListing(
  raw: unknown,
  index: number,
): { listing: NormalisedListing } | { problem: ListingProblem } {
  if (typeof raw !== 'object' || raw === null) {
    return { problem: { index, title: '(not an object)', reason: 'Listing must be an object' } };
  }

  const input = raw as Record<string, unknown>;
  // Accept camelCase (extension) and snake_case (direct API use) alike.
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
        return input[key];
      }
    }
    return undefined;
  };

  const title = str(pick('title'), 500);
  if (!title) {
    return { problem: { index, title: '(untitled)', reason: 'Missing a title' } };
  }

  const soldPrice = parsePrice(pick('soldPrice', 'sold_price', 'price'));
  if (soldPrice === null) {
    return { problem: { index, title, reason: 'Missing or unreadable sold price' } };
  }
  if (soldPrice < 0 || soldPrice > 1_000_000) {
    return { problem: { index, title, reason: `Sold price out of range (${soldPrice})` } };
  }

  const shippingPrice = parsePrice(pick('shippingPrice', 'shipping_price', 'shipping'));
  const itemUrl = sanitiseUrl(pick('itemUrl', 'item_url', 'url'));
  const itemId = extractItemId(pick('itemId', 'item_id', 'id'), itemUrl);
  const soldDate = parseSoldDate(pick('soldDate', 'sold_date', 'dateSold'));

  const canonicalUrl = canonicalItemUrl(itemUrl);
  const dedupeKey = itemId
    ? `id:${itemId}`
    : canonicalUrl
      ? `url:${canonicalUrl}`
      : `fb:${title.toLowerCase()}|${soldPrice.toFixed(2)}|${soldDate ?? 'unknown'}`;

  return {
    listing: {
      item_id: itemId,
      title,
      sold_price: soldPrice,
      shipping_price: shippingPrice,
      total_price: Math.round((soldPrice + (shippingPrice ?? 0)) * 100) / 100,
      sold_date: soldDate,
      condition: str(pick('condition'), 120),
      image_url: sanitiseUrl(pick('imageUrl', 'image_url', 'image')),
      item_url: itemUrl,
      dedupe_key: dedupeKey.slice(0, 600),
    },
  };
}

export interface PriceStats {
  count: number;
  average: number | null;
  median: number | null;
  lowest: number | null;
  highest: number | null;
}

/** Total, average, median, lowest and highest — nothing more for this version. */
export function priceStats(prices: number[]): PriceStats {
  const values = prices.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  if (!values.length) {
    return { count: 0, average: null, median: null, lowest: null, highest: null };
  }

  const sum = values.reduce((total, value) => total + value, 0);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    count: values.length,
    average: round(sum / values.length),
    median: round(median),
    lowest: round(values[0]),
    highest: round(values[values.length - 1]),
  };
}
