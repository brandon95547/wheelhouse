/*
 * ============================================================================
 * Wheelhouse eBay listing parser
 * ============================================================================
 *
 * This file is the ONLY place that knows what eBay's markup looks like. When
 * eBay changes its page structure, this is the file to update — nothing else
 * in the extension or in Wheelhouse needs to change.
 *
 * How it works
 * ------------
 * `STRATEGIES` holds one entry per page layout we know about. Each strategy
 * lists the selectors that find the listing cards, plus the selectors for the
 * fields inside a card. Every strategy is tried, and the one that produces the
 * most usable listings wins. Field lookups fall back to scanning the card's
 * text with a regular expression, so a strategy still returns something useful
 * when a single selector goes stale.
 *
 * It runs only when the user clicks the extension. It reads the page that is
 * already on screen — it never navigates, never fetches from eBay, never
 * touches cookies or credentials, and never runs in the background.
 *
 * >>> UPDATING SELECTORS <<<
 * Search this file for "SELECTORS —". Each block is a plain array of CSS
 * selectors tried in order. Add the new selector to the front of the relevant
 * array; leave the old ones in place so older page variants keep working.
 */

(function () {
  'use strict';

  const VERSION = '0.1.0';

  /* ---------------------------------------------------------------- utils */

  const clean = (value) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  /** First non-empty text content from a list of selectors. */
  function pickText(root, selectors) {
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue; // A malformed selector should never break the whole parse.
      }
      for (const node of nodes) {
        const text = clean(node.textContent);
        if (text) return text;
      }
    }
    return null;
  }

  /**
   * Every non-empty text inside the given selectors, in document order, each
   * tagged with the selector that found it. Field lookups need this because a
   * generic selector such as `.s-card__attribute-row` matches the price row,
   * the shipping row and more — taking only the first match picks the wrong
   * one.
   */
  function collectTexts(root, selectors) {
    const found = [];
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        const text = clean(node.textContent);
        if (text) found.push({ selector, text });
      }
    }
    return found;
  }

  /** First non-empty attribute value from a list of selectors. */
  function pickAttr(root, selectors, attribute) {
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        const value = node.getAttribute(attribute);
        if (value && value.trim()) return value.trim();
      }
    }
    return null;
  }

  const PRICE_PATTERN = /(?:US\s*)?[$£€¥]\s?\d[\d.,]*/;
  const CONDITION_PATTERN =
    /\b(brand new(?: with tags| without tags| with box| with defects)?|new \(other\)|new with(?:out)? (?:tags|box)|new other|pre-?owned|open box|certified refurbished|(?:seller|excellent|very good|good) refurbished|refurbished|used|for parts or not working)\b/i;
  /** "Jul 14, 2026", "14 Jul 2026", "07/14/2026" or "2026-07-14". */
  const DATE_PATTERN =
    /(?:[A-Za-z]{3,9}[\s.-]+\d{1,2},?[\s.-]+\d{4})|(?:\d{1,2}[\s.-]+[A-Za-z]{3,9}[\s.-]+\d{4})|(?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:\d{4}-\d{2}-\d{2})/;
  const SOLD_DATE_PATTERN = new RegExp(
    `sold\\s+(?:on\\s+)?(${DATE_PATTERN.source})`,
    'i',
  );
  const FREE_SHIPPING_PATTERN = /\bfree\s+(?:shipping|delivery|postage|p&p)\b/i;
  const PAID_SHIPPING_PATTERN =
    /(?:\+\s*)?((?:US\s*)?[$£€¥]\s?\d[\d.,]*)\s*(?:for\s+)?(?:shipping|delivery|postage|p&p)/i;

  /** Selectors whose name says they hold a shipping cost. */
  const SHIPPING_SELECTOR = /shipping|logistics|delivery|postage/i;
  /** Selectors whose name says they hold a date. */
  const DATE_SELECTOR = /date|sold|caption|tagblock/i;

  /** Removes the badges eBay prefixes onto card titles. */
  function tidyTitle(raw) {
    if (!raw) return null;
    return (
      clean(raw)
        .replace(/^(new listing|sponsored|opens in a new window or tab)\s*/i, '')
        .replace(/\s*opens in a new window or tab\s*$/i, '')
        .trim() || null
    );
  }

  /** Skips eBay's own placeholder and 1x1 tracking images. */
  function usableImage(url) {
    if (!url) return null;
    if (url.startsWith('data:')) return null;
    if (/\/s-l\d+\.(?:png|gif)(?:\?|$)/i.test(url)) return null; // grey placeholder
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  }

  function findImage(card) {
    const images = card.querySelectorAll('img');
    for (const img of images) {
      const candidates = [
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-defaultsrc'),
        img.getAttribute('data-originalsrc'),
      ];
      const srcset = img.getAttribute('srcset');
      if (srcset) candidates.push(srcset.split(',')[0]?.trim().split(/\s+/)[0]);

      for (const candidate of candidates) {
        const usable = usableImage(candidate);
        if (usable) return usable;
      }
    }
    return null;
  }

  function findItemUrl(card, selectors) {
    const href = pickAttr(card, selectors, 'href');
    if (href) {
      try {
        return new URL(href, location.href).toString();
      } catch {
        /* Ignore an unparseable href and fall through. */
      }
    }
    return null;
  }

  function findItemId(card, itemUrl) {
    // Data attributes are the most reliable source when eBay provides them.
    const attrNames = ['data-itemid', 'data-listing-id', 'data-listingid', 'data-item-id'];
    for (const name of attrNames) {
      const holder = card.matches?.(`[${name}]`) ? card : card.querySelector(`[${name}]`);
      const value = holder?.getAttribute(name);
      if (value && /^\d{9,15}$/.test(value.trim())) return value.trim();
    }
    if (itemUrl) {
      const match = itemUrl.match(/\/itm\/(?:[^/?#]*\/)?(\d{9,15})/);
      if (match) return match[1];
    }
    // Some layouts encode the id in the element id, e.g. "item3f1a2b".
    const idAttr = card.getAttribute?.('id') ?? '';
    const idMatch = idAttr.match(/(\d{9,15})/);
    return idMatch ? idMatch[1] : null;
  }

  function findShipping(card, selectors) {
    const candidates = collectTexts(card, selectors);

    // "Free shipping" / "+$12.95 shipping" wherever it appears, in page order.
    for (const { text } of candidates) {
      if (FREE_SHIPPING_PATTERN.test(text)) return 'Free';
      const paid = text.match(PAID_SHIPPING_PATTERN);
      if (paid) return paid[1];
    }

    // A shipping-specific element may hold a bare price with no wording.
    for (const { selector, text } of candidates) {
      if (!SHIPPING_SELECTOR.test(selector)) continue;
      const match = text.match(PRICE_PATTERN);
      if (match) return match[0];
    }

    const all = clean(card.textContent);
    if (FREE_SHIPPING_PATTERN.test(all)) return 'Free';
    const paid = all.match(PAID_SHIPPING_PATTERN);
    return paid ? paid[1] : null;
  }

  function findSoldDate(card, selectors) {
    const candidates = collectTexts(card, selectors);

    for (const { text } of candidates) {
      const match = text.match(SOLD_DATE_PATTERN);
      if (match) return match[1];
    }

    // A dedicated "date sold" column holds the date without the word "Sold".
    for (const { selector, text } of candidates) {
      if (!DATE_SELECTOR.test(selector)) continue;
      const match = text.match(DATE_PATTERN);
      if (match) return match[0];
    }

    const match = clean(card.textContent).match(SOLD_DATE_PATTERN);
    return match ? match[1] : null;
  }

  function findCondition(card, selectors) {
    for (const { text } of collectTexts(card, selectors)) {
      const match = text.match(CONDITION_PATTERN);
      if (match) return match[0];
    }
    const match = clean(card.textContent).match(CONDITION_PATTERN);
    return match ? match[0] : null;
  }

  function findPrice(card, selectors) {
    for (const { text } of collectTexts(card, selectors)) {
      // Skip rows that are describing shipping rather than the sold price.
      if (FREE_SHIPPING_PATTERN.test(text) || PAID_SHIPPING_PATTERN.test(text)) continue;
      const match = text.match(PRICE_PATTERN);
      if (match) return match[0];
    }
    const match = clean(card.textContent).match(PRICE_PATTERN);
    return match ? match[0] : null;
  }

  /* ----------------------------------------------------------- strategies */

  /**
   * SELECTORS — search results, current card layout (`s-card` / `su-card-*`).
   * eBay rolled this out across search results from 2024 onwards.
   */
  const SEARCH_CARD = {
    name: 'search-results-card',
    label: 'eBay search results',
    containers: [
      'ul.srp-results li.s-card',
      'li.s-card',
      '.su-card-container',
      '[data-testid="item-card"]',
    ],
    fields: {
      title: ['.s-card__title', '.su-card-container__header .su-styled-text', '[role="heading"]'],
      price: ['.s-card__price', '.su-card-container__attribute-row .su-styled-text.bold', '.s-card__attribute-row'],
      shipping: ['.s-card__logisticsCost', '.s-card__attribute-row', '.su-card-container__attribute-row'],
      soldDate: ['.s-card__caption', '.su-card-container__caption', '.s-card__attribute-row'],
      condition: ['.s-card__subtitle', '.su-card-container__subtitle', '.s-card__attribute-row'],
      link: ['a.su-link', 'a[href*="/itm/"]'],
    },
  };

  /**
   * SELECTORS — search results, legacy card layout (`s-item`).
   * Still served on some eBay sites and on older cached pages.
   */
  const SEARCH_ITEM = {
    name: 'search-results-legacy',
    label: 'eBay search results (legacy layout)',
    containers: ['ul.srp-results li.s-item', 'li.s-item', '.srp-river-results .s-item'],
    fields: {
      title: ['.s-item__title', 'h3.s-item__title', '[role="heading"]'],
      price: ['.s-item__price', '.s-item__detail--primary .s-item__price'],
      shipping: ['.s-item__shipping', '.s-item__logisticsCost', '.s-item__freeXDays'],
      soldDate: ['.s-item__title--tagblock .POSITIVE', '.s-item__title--tagblock', '.s-item__caption'],
      condition: ['.s-item__subtitle', '.SECONDARY_INFO'],
      link: ['a.s-item__link', 'a[href*="/itm/"]'],
    },
  };

  /**
   * SELECTORS — Seller Hub "Product Research" (Terapeak) result rows.
   *
   * Terapeak renders a table rather than cards, and its class names are the
   * least stable of the three. If imports from Product Research come back
   * empty, this is the block to update first — the generic row fallback below
   * usually still catches the price and date.
   */
  const PRODUCT_RESEARCH = {
    name: 'product-research',
    label: 'eBay Product Research',
    containers: [
      '.research-table-row',
      '[class*="research-table-row"]:not([class*="header"])',
      '.research-table__row',
      'table tbody tr[data-item-id]',
    ],
    fields: {
      title: [
        '.research-table-row__item-title',
        '.research-table-row__title',
        '[class*="item-title"]',
        'a[href*="/itm/"]',
      ],
      price: [
        '.research-table-row__item--avgSoldPrice',
        '[class*="avgSoldPrice"]',
        '[class*="soldPrice"]',
        '[class*="price"]',
      ],
      shipping: ['[class*="shipping"]', '[class*="ShippingPrice"]'],
      soldDate: ['[class*="dateLastSold"]', '[class*="lastSold"]', '[class*="date"]'],
      condition: ['[class*="condition"]'],
      link: ['a[href*="/itm/"]'],
    },
  };

  const STRATEGIES = [SEARCH_CARD, SEARCH_ITEM, PRODUCT_RESEARCH];

  /* -------------------------------------------------------------- parsing */

  function collectCards(strategy) {
    for (const selector of strategy.containers) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      if (nodes.length) return [...nodes];
    }
    return [];
  }

  function parseCard(card, strategy) {
    const { fields } = strategy;

    const title = tidyTitle(pickText(card, fields.title));
    // eBay pads result lists with a hidden "Shop on eBay" template card.
    if (!title || /^shop on ebay$/i.test(title)) return null;

    const soldPrice = findPrice(card, fields.price);
    if (!soldPrice) return null;

    const itemUrl = findItemUrl(card, fields.link);

    return {
      itemId: findItemId(card, itemUrl),
      title,
      soldPrice,
      shippingPrice: findShipping(card, fields.shipping),
      soldDate: findSoldDate(card, fields.soldDate),
      condition: findCondition(card, fields.condition),
      imageUrl: findImage(card),
      itemUrl,
    };
  }

  function runStrategy(strategy) {
    const cards = collectCards(strategy);
    const listings = [];
    let skipped = 0;

    for (const card of cards) {
      let listing = null;
      try {
        listing = parseCard(card, strategy);
      } catch {
        listing = null; // One broken card must not stop the rest.
      }
      if (listing) listings.push(listing);
      else skipped += 1;
    }

    return { strategy: strategy.name, label: strategy.label, cards: cards.length, listings, skipped };
  }

  /* ------------------------------------------------------------ page kind */

  function detectPage() {
    const host = location.hostname;
    const isEbay = /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(host);
    const path = location.pathname;
    const query = location.search;

    const isSearch = /\/sch\//.test(path) || /\/b\//.test(path);
    const isResearch = /\/sh\/research/.test(path);
    const soldFilter = /LH_Sold=1/.test(query) || /LH_Complete=1/.test(query);

    let kind = 'other';
    if (isResearch) kind = 'product-research';
    else if (isSearch) kind = soldFilter ? 'sold-search' : 'search';

    return {
      isEbay,
      kind,
      soldFilter,
      isResultsPage: isEbay && (isSearch || isResearch),
      url: location.href,
      host,
    };
  }

  /* -------------------------------------------------------------- extract */

  /**
   * Reads the listings currently rendered on the page.
   * Returns { page, found, listings, diagnostics } — never throws.
   */
  function extractAll() {
    const page = detectPage();
    const attempts = STRATEGIES.map(runStrategy);

    // The layout that yields the most listings is the one the page is using.
    const best = attempts.reduce(
      (winner, attempt) =>
        attempt.listings.length > (winner?.listings.length ?? 0) ? attempt : winner,
      null,
    );

    return {
      parserVersion: VERSION,
      page,
      strategy: best && best.listings.length ? best.strategy : null,
      strategyLabel: best && best.listings.length ? best.label : null,
      found: best ? best.listings.length : 0,
      listings: best ? best.listings : [],
      diagnostics: attempts.map((attempt) => ({
        strategy: attempt.strategy,
        cardsFound: attempt.cards,
        listingsParsed: attempt.listings.length,
        cardsSkipped: attempt.skipped,
      })),
    };
  }

  globalThis.WheelhouseParser = { VERSION, extractAll, detectPage };
})();
