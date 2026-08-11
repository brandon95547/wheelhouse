/*
 * ============================================================================
 * Lookout — brand classifier
 * ============================================================================
 *
 * Identifies the brand behind a sold listing. This is the judgement layer; parser.js
 * knows eBay's markup and nothing else, this knows the trade and nothing about HTML.
 *
 * IT NO LONGER DECIDES WHAT IS WORTH BUYING, AND THAT IS THE POINT.
 *
 * This began as a classifier against a compiled Reseller Brand Guide: ~480 brands the
 * guide called worth-on-sight, ~235 it called model-dependent. That guide was written to
 * inspire the design, not to be loaded in as data, and a shipped list of someone else's
 * verdicts is exactly the pre-judgement the brand book exists to replace. So the catalog
 * is gone, and with it every opinion this file used to hold.
 *
 * What replaces it is the market:
 *
 *   observed   A brand seen selling on the page being scanned. Named from eBay's own
 *              Brand facet where the page offers one — authoritative spelling, straight
 *              from eBay's aspect data — and inferred from repeated title words where it
 *              does not. Carries a sold count and a median, and NO verdict.
 *
 *   unlisted   No brand could be identified in the title at all.
 *
 * Everything observed reaches Wheelhouse as `unsorted`, where a human decides whether it
 * is Rare, Common, or nothing. The scan's job is to report what sells and for how much;
 * deciding what that means is the part a person does.
 *
 * The master/exception path below is retained because a catalog can still be supplied —
 * the tests exercise it, and a hand-built seed list would use it — but nothing ships one.
 */

const MASTER = 'master';
const EXCEPTION = 'exception';
const OBSERVED = 'observed';

/** Must stay identical to normalise() in tools/build-catalog.mjs. */
export function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Provenance and construction signals, matched against the whole title. These satisfy
   the exception rules that ask for something no model name can express — "England-made",
   "vintage", "collaborations". Weaker evidence than a model hit, and reported as such. */
const SIGNAL_TESTS = {
  collaboration: /\bcollabs?\b|\bcollaboration\b|\bx\b/,
  vintage: /\bvintage\b|\bvtg\b|\bretro\b/,
  usaMade: /\bmade in (?:the )?usa\b|\busa made\b|\bus made\b|\bunion made\b/,
  ukMade: /\bmade in (?:england|uk|britain|great britain)\b|\bengland made\b|\buk made\b/,
  italyMade: /\bmade in italy\b|\bitalian made\b|\bitaly made\b/,
  exoticLeather: /\bostrich\b|\bcaiman\b|\balligator\b|\bcrocodile\b|\blizard\b|\belephant\b|\bstingray\b|\bpython\b|\bexotic\b/,
  goreTex: /\bgore ?tex\b|\bgtx\b/,
};

/**
 * Build the lookup structure the classifier uses.
 *
 * Aliases are indexed by their FIRST word so a title only has to be checked against the
 * handful of brands that could possibly start there, rather than all 400. At a few
 * hundred listings per page and two catalogs loaded, the naive scan is the difference
 * between instant and visibly slow.
 */
export function buildIndex(catalogs) {
  const byFirstWord = new Map();
  const brands = new Map();

  const add = (entry, tier, scope) => {
    const key = `${tier}:${entry.name}`;
    const record = brands.get(key) ?? {
      name: entry.name,
      tier,
      kind: entry.kind ?? null,
      scopes: new Set(),
      models: entry.models ?? [],
      signals: entry.signals ?? [],
      rule: entry.rule ?? null,
    };
    record.scopes.add(scope);
    brands.set(key, record);

    for (const alias of entry.aliases ?? []) {
      const words = alias.split(' ');
      const bucket = byFirstWord.get(words[0]) ?? [];
      bucket.push({ alias, words, key });
      byFirstWord.set(words[0], bucket);
    }
  };

  for (const catalog of catalogs) {
    for (const entry of catalog.master ?? []) add(entry, MASTER, catalog.scope);
    for (const entry of catalog.exceptions ?? []) add(entry, EXCEPTION, catalog.scope);
    // Brands observed on the page itself. No tier, no models, no rule — just a name
    // and the spelling eBay uses for it.
    for (const entry of catalog.observed ?? []) add(entry, OBSERVED, catalog.scope);
  }

  // Longest alias first, so "polo ralph lauren" wins over "ralph lauren" and
  // "a bathing ape" over any single-word neighbour.
  for (const bucket of byFirstWord.values()) bucket.sort((a, b) => b.words.length - a.words.length);

  return { byFirstWord, brands };
}

/**
 * An index built from brand names the scan actually saw, rather than a shipped guide.
 *
 * The names come from eBay's Brand facet, which is the best vocabulary available: it is
 * eBay's own aspect data, spelled the way eBay indexes it, and scoped to the very search
 * being run. A page about men's boots offers boot brands and nothing else, so the index
 * is small, relevant, and costs nothing to rebuild as later pages add names.
 *
 * Aliases are generated rather than curated — the full name, and the name minus a
 * parenthetical, which is the only variation eBay's own labels reliably contain.
 */
export function buildObservedIndex(names, scope = 'observed') {
  const seen = new Set();
  const observed = [];

  for (const raw of names) {
    const name = String(raw?.name ?? raw ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) continue;
    if (/^(unbranded|no brand|handmade|other|see photos?|n\/?a)$/i.test(name)) continue;

    const aliases = new Set([normalise(name)]);
    const withoutParens = normalise(name.replace(/\([^)]*\)/g, ' '));
    if (withoutParens) aliases.add(withoutParens);

    for (const alias of aliases) {
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
    }
    observed.push({ name, aliases: [...aliases].filter(Boolean) });
  }

  return buildIndex([{ scope, observed }]);
}

/**
 * Does a title word satisfy a model word?
 *
 * Exact, except for numeric model families, which sellers write with the version
 * attached: the guide says 990, the listing says "990v5". Matching those literally
 * rejects the exact shoe the rule was written to catch. Only applied when the model
 * token is purely numeric, so it cannot loosen anything else.
 */
function wordMatches(titleWord, modelWord) {
  if (titleWord === modelWord) return true;
  if (!/^\d+$/.test(modelWord)) return false;
  return new RegExp(`^${modelWord}v\\d+$`).test(titleWord);
}

/** Longest alias match anywhere in the title, preferring earlier positions. */
function findBrand(index, words) {
  let best = null;
  for (let i = 0; i < words.length; i += 1) {
    const bucket = index.byFirstWord.get(words[i]);
    if (!bucket) continue;
    for (const candidate of bucket) {
      if (candidate.words.length > words.length - i) continue;
      let matched = true;
      for (let k = 1; k < candidate.words.length; k += 1) {
        if (words[i + k] !== candidate.words[k]) { matched = false; break; }
      }
      if (!matched) continue;
      // A longer name is a more specific claim; on a tie the earlier one wins, because
      // eBay sellers lead with the brand.
      if (!best || candidate.words.length > best.words.length) {
        best = { ...candidate, at: i };
      }
      break; // bucket is longest-first, so the first hit here is the best for this word
    }
  }
  return best;
}

/**
 * Classify one listing.
 *
 * Returns { verdict, brand, tier, matchedModels, matchedSignals, reason }.
 *   worthy        buy signal: master brand, or an exception with its model/provenance met
 *   model-missing an exception brand whose rule was not satisfied — the common case for
 *                 Nike, Adidas and Levi's, and the thing that keeps the list honest
 *   unlisted      not in the guide; counted as a discovery candidate
 */
export function classify(index, listing) {
  const title = normalise(listing.title);
  const words = title.split(' ').filter(Boolean);
  const hit = findBrand(index, words);

  if (!hit) {
    return { verdict: 'unlisted', brand: null, tier: null, matchedModels: [], matchedSignals: [], reason: 'No catalog brand in the title' };
  }

  const brand = index.brands.get(hit.key);

  // Seen selling, and nothing more is claimed. No tier, no rule, no buy signal — the
  // scan reports the market and Wheelhouse asks a human what it means.
  if (brand.tier === OBSERVED) {
    return {
      verdict: 'observed',
      brand: brand.name,
      tier: OBSERVED,
      kind: brand.kind,
      matchedModels: [],
      matchedSignals: [],
      rule: null,
      reason: 'Seen selling on this page — not yet judged',
    };
  }

  if (brand.tier === MASTER) {
    return {
      verdict: 'worthy',
      brand: brand.name,
      tier: MASTER,
      kind: brand.kind,
      matchedModels: [],
      matchedSignals: [],
      // A master brand is the pickup signal by itself, so it carries no qualification.
      // Downstream treats a null rule on an exception as "not safe to call common".
      rule: null,
      reason: 'Master list — inspect on sight',
    };
  }

  const matchedModels = brand.models.filter((model) => {
    const needle = model.split(' ');
    for (let i = 0; i + needle.length <= words.length; i += 1) {
      let ok = true;
      for (let k = 0; k < needle.length; k += 1) {
        if (!wordMatches(words[i + k], needle[k])) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  });

  const matchedSignals = brand.signals.filter((signal) => SIGNAL_TESTS[signal]?.test(title));

  if (matchedModels.length || matchedSignals.length) {
    return {
      verdict: 'worthy',
      brand: brand.name,
      tier: EXCEPTION,
      kind: brand.kind,
      matchedModels,
      matchedSignals,
      rule: brand.rule ?? null,
      reason: matchedModels.length
        ? `Exception met: ${matchedModels.join(', ')}`
        : `Exception met on provenance: ${matchedSignals.join(', ')}`,
    };
  }

  return {
    verdict: 'model-missing',
    brand: brand.name,
    tier: EXCEPTION,
    kind: brand.kind,
    matchedModels: [],
    matchedSignals: [],
    rule: brand.rule ?? null,
    reason: brand.rule ? `Requires: ${brand.rule}` : 'Requires a specific model',
  };
}

/* ------------------------------------------------------------------ discovery */

/* Words that lead a title but are not a brand. Without this every scan "discovers"
   Mens, Vintage and Size as promising new labels. */
const TITLE_NOISE = new Set([
  'mens', 'men', 'womens', 'women', 'unisex', 'kids', 'youth', 'boys', 'girls',
  'new', 'nwt', 'nwob', 'nib', 'vintage', 'vtg', 'rare', 'euc', 'nwot',
  'size', 'sz', 'us', 'uk', 'eu', 'authentic', 'genuine', 'lot', 'pair',
  'black', 'white', 'brown', 'blue', 'red', 'green', 'grey', 'gray', 'tan',
  'navy', 'beige', 'cream', 'pink', 'purple', 'yellow', 'orange', 'silver', 'gold',
  'leather', 'suede', 'canvas', 'mesh', 'nylon', 'wool', 'denim',
  'shoes', 'shoe', 'boots', 'boot', 'sneakers', 'sneaker', 'trainers', 'loafers',
  'sandals', 'heels', 'flats', 'pumps', 'oxfords', 'the', 'and', 'with', 'for',
]);

/**
 * Candidate brand names from the titles nothing matched.
 *
 * eBay sellers lead with the brand, so the first one or two meaningful words of an
 * unmatched title are the best guess at a label the guide does not have yet. This is a
 * suggestion engine, not a classifier — its output is for a human to read before the
 * next revision of the guide, which is why it returns evidence (how many, how much)
 * rather than a verdict.
 */
export function discoverCandidates(unlistedListings, { minCount = 3 } = {}) {
  const counts = new Map();

  for (const listing of unlistedListings) {
    const words = normalise(listing.title).split(' ').filter((w) => w && !TITLE_NOISE.has(w) && !/^\d+$/.test(w));
    if (!words.length) continue;
    for (const candidate of [words[0], words.slice(0, 2).join(' ')]) {
      if (!candidate || candidate.length < 3) continue;
      const row = counts.get(candidate) ?? { name: candidate, count: 0, prices: [] };
      row.count += 1;
      if (typeof listing.priceValue === 'number') row.prices.push(listing.priceValue);
      counts.set(candidate, row);
    }
  }

  return [...counts.values()]
    .filter((row) => row.count >= minCount)
    .map((row) => ({ name: row.name, count: row.count, medianPrice: median(row.prices) }))
    .sort((a, b) => b.count - a.count || (b.medianPrice ?? 0) - (a.medianPrice ?? 0));
}

export function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

/**
 * Roll classified listings up per brand.
 *
 * The per-brand numbers are EVIDENCE, not the verdict — the guide already decided what is
 * worth looking for. What the scan adds is what that brand actually fetches and how often
 * it turns up, which is what tells you whether it is worth the walk across the store.
 */
export function summarise(rows) {
  const brands = new Map();

  for (const row of rows) {
    if (!row.classification.brand) continue;
    const key = row.classification.brand;
    const entry = brands.get(key) ?? {
      brand: key,
      tier: row.classification.tier,
      kind: row.classification.kind ?? null,
      // The guide's own words for what makes this brand worth picking up. Carried
      // through to Wheelhouse, which refuses to file a brand as common without it.
      rule: row.classification.rule ?? null,
      sold: 0,
      modelMissing: 0,
      prices: [],
      models: new Map(),
      signals: new Set(),
      examples: [],
    };

    // `observed` counts exactly like `worthy`: both mean "this brand sold, at this
    // price". The difference is only whether a guide had an opinion about it, and with
    // no guide shipped that difference is now almost always moot.
    if (row.classification.verdict === 'worthy' || row.classification.verdict === 'observed') {
      entry.sold += 1;
      if (typeof row.priceValue === 'number') entry.prices.push(row.priceValue);
      for (const m of row.classification.matchedModels) entry.models.set(m, (entry.models.get(m) ?? 0) + 1);
      for (const s of row.classification.matchedSignals) entry.signals.add(s);
      if (entry.examples.length < 5) {
        entry.examples.push({ title: row.title, price: row.priceValue, url: row.itemUrl });
      }
    } else {
      entry.modelMissing += 1;
    }
    brands.set(key, entry);
  }

  return [...brands.values()]
    .filter((entry) => entry.sold > 0)
    .map((entry) => ({
      brand: entry.brand,
      tier: entry.tier,
      kind: entry.kind,
      lookFor: entry.rule,
      soldCount: entry.sold,
      rejectedCount: entry.modelMissing,
      medianPrice: median(entry.prices),
      highPrice: entry.prices.length ? Math.max(...entry.prices) : null,
      models: [...entry.models.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      signals: [...entry.signals],
      examples: entry.examples,
    }))
    .sort((a, b) => (b.medianPrice ?? 0) - (a.medianPrice ?? 0) || b.soldCount - a.soldCount);
}
