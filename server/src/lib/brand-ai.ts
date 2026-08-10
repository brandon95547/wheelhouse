/**
 * Classify a scan's sold listings into Rare / Common / Not worthy, in ONE call.
 *
 * The whole batch goes to the model together, and that is the design rather than an
 * economy. A brand cannot be judged one listing at a time: the question is whether its
 * CHEAP sales are also worth money, which only exists in the shape of the whole set. Ten
 * separate calls would each see a fragment and none would see the pattern — and would
 * cost ten times as much to be worse.
 *
 * An earlier version split this into an extraction pass and a judgement pass. It timed
 * out: asking for every brand plus every misspelling of it across 120 titles produces a
 * huge reply, the model exhausts its budget mid-JSON, the retry runs at triple the budget,
 * and a second call follows. Three minutes on 151 listings, for an answer one call gives.
 *
 * FAILURE IS NOT FATAL. Returning null leaves the caller with the statistical scorer,
 * which needs no third party. An import must never die because an API is down.
 */
import { chatJSON, aiConfigured } from './deepseek.js';
import { normaliseBrand } from './brands.js';

export interface AiListing {
  title: string;
  sold_price: number | null;
}

export type AiTier = 'rare' | 'common' | 'not_worthy' | 'unsorted';

export interface AiBrandVerdict {
  name: string;
  tier: AiTier;
  /** The specific models worth picking up under a common brand. Empty for other tiers. */
  models: string[];
  lookFor: string | null;
  reasoning: string;
}

/**
 * Sales a brand needs before any verdict about it is kept.
 *
 * ASKED FOR IN THE PROMPT, ENFORCED HERE, because asking was not enough. Told plainly to
 * answer "unsorted" when a brand had too few listings to judge, the model still returned
 * not_worthy for a boot that had sold once, for $600 — a book that says "skip this" about
 * a $600 boot is worse than no book at all.
 *
 * Three is the smallest number that can show a pattern rather than an incident. Below it
 * the brand is filed unsorted with its sales intact, and judged once more have accumulated.
 */
const MIN_EVIDENCE = 3;

/**
 * Listings per call. The batch is meant to go over whole; this only exists so a scan far
 * larger than a normal page cannot blow the context window. Well above the ~200 a scan
 * actually produces.
 */
const MAX_PER_CALL = 250;

const SYSTEM = `You are analyzing a batch of eBay SOLD listings to determine which brands are worth picking up for resale.

Review ALL listings together. Use the listing titles and sold prices to identify brands, group their sales, determine what is driving their resale value, and classify each brand.

Classify every identifiable brand into exactly one of these categories:

### RARE

The BRAND ITSELF is the pickup signal.

Use Rare when the sold listings show that normal items across the brand consistently have worthwhile resale value. The value should not depend primarily on finding a particular model, line, material, vintage version, collaboration, or special edition.

Ask:

**If I found a random item from this brand at a thrift store, would the brand name alone make it worth picking up or seriously inspecting?**

Do not classify a brand as Rare just because it has several expensive listings. Look at the overall pattern of sales and make sure expensive models are not creating a misleading impression of the brand as a whole.

### COMMON

The MODEL OR VERSION is the pickup signal, not the brand itself.

Use Common when ordinary items from the brand are not consistently worth picking up, but specific models, lines, materials, eras, countries of manufacture, collaborations, or special versions repeatedly sell for worthwhile prices.

For every Common brand, identify exactly what the reseller should look for.

Never give vague advice such as "premium models," "certain styles," or "higher-end versions."

Example:

Nike
Look for: Jordan, Kobe, SB Dunk, Foamposite, desirable Air Max, ACG, collaborations.

If you cannot identify specific worthwhile models or versions from the sold listings, do NOT classify the brand as Common.

### NOT WORTHY

Use Not Worthy when the brand generally does not have enough resale value AND you cannot identify specific models or versions that consistently make it worth picking up.

A few unusually expensive sales should not prevent a brand from being classified Not Worthy.

### UNSORTED

Use Unsorted when the batch contains too few listings from a brand to judge it at all.

With only one or two sales you cannot tell whether the brand's value is consistent or
concentrated in a particular model — both look identical. Say so rather than guessing.

This matters most for expensive one-offs. A single boot that sold for $600 is not evidence
that the brand is Rare, and it is certainly not evidence that it is Not Worthy. It is one
sale. Return Unsorted and it will be judged later, when more of its sales have been seen.

NEVER return Not Worthy because you have too little data. Not Worthy means the sales show
the brand does not sell — not that you could not tell.

### HOW TO JUDGE THE DATA

Use the ENTIRE set of sold listings for each brand.

Pay attention to:

* Typical sold prices
* Consistency of sold prices
* Low-priced sales as well as high-priced sales
* Whether most ordinary examples have worthwhile value
* Whether high prices are concentrated in particular models
* Repeated model names among high-value sales
* Materials, vintage eras, collaborations, country of manufacture, or other identifiable characteristics associated with higher prices
* Outliers that should not represent the brand as a whole

Do not let brand reputation influence the decision. Judge from the SOLD LISTINGS provided.

Do not assume that an expensive or famous brand is automatically Rare.

### OUTPUT

Return JSON only:

{
"brands": [
{
"name": "Brand Name",
"tier": "rare",
"models": [],
"lookFor": null,
"reasoning": "Short explanation based on the sold listings."
},
{
"name": "Brand Name",
"tier": "common",
"models": ["Model A", "Model B", "Model C"],
"lookFor": "Model A, Model B, Model C and other specific worthwhile versions identified from the listings.",
"reasoning": "Ordinary examples sell lower, while these specific models repeatedly command worthwhile prices."
},
{
"name": "Brand Name",
"tier": "not_worthy",
"models": [],
"lookFor": null,
"reasoning": "Short explanation based on the sold listings."
},
{
"name": "Brand Name",
"tier": "unsorted",
"models": [],
"lookFor": null,
"reasoning": "Only 2 sales in this batch — not enough to judge the brand."
}
]
}

Important:

**Rare = brand is the reason to pick it up.**

**Common = specific model/version is the reason to pick it up.**

**Not Worthy = neither the brand nor identifiable models provide a strong enough resale signal.**

**Unsorted = too few listings from this brand to judge it either way.**

Analyze patterns across ALL provided sold listings rather than making decisions from a few high-priced examples.

Keep every "reasoning" under 20 words. Be terse — a scan can contain sixty brands and the reply must fit in one response.`;

interface RawVerdict {
  name?: unknown;
  tier?: unknown;
  models?: unknown;
  lookFor?: unknown;
  reasoning?: unknown;
}

/** Price first, so the number the judgement turns on leads every line. */
const asLine = (l: AiListing): string =>
  `$${l.sold_price ?? '?'} ${String(l.title ?? '').replace(/\s+/g, ' ').trim()}`;

/**
 * Text that only gestures at quality. The prompt forbids it, and the model mostly obeys,
 * but "premium models" reaching the brand book would read as an endorsement of everything
 * the brand makes — the exact failure the Common tier exists to prevent.
 */
function isVague(lookFor: string, models: string[]): boolean {
  if (lookFor.length < 6) return true;
  if (models.length > 0) return false;
  return /^(premium|higher[- ]?end|various|several|certain|specific|good|nice|better|quality)\b/i
    .test(lookFor);
}

/**
 * How many of these listings mention this brand.
 *
 * Word-boundary match on the same normaliser the slug uses, so "Dr. Martens" counts
 * "Dr Martens". Approximate by nature — a listing that never names its brand cannot be
 * counted — but it only ever withholds a verdict, never invents one.
 */
function evidenceFor(name: string, listings: AiListing[]): number {
  const needle = normaliseBrand(name).split(' ').filter(Boolean);
  if (!needle.length) return 0;

  let count = 0;
  for (const listing of listings) {
    const words = normaliseBrand(listing.title).split(' ').filter(Boolean);
    for (let i = 0; i + needle.length <= words.length; i += 1) {
      if (needle.every((w, k) => words[i + k] === w)) { count += 1; break; }
    }
  }
  return count;
}

/** One call. Returns the brands it could identify, or null if the model was unusable. */
async function classifyChunk(listings: AiListing[]): Promise<AiBrandVerdict[] | null> {
  const result = await chatJSON<{ brands?: unknown }>({
    system: SYSTEM,
    user: JSON.stringify({ listings: listings.map(asLine) }),
    /* Sized so ONE call suffices. Measured on 151 listings -> 59 brands: 16,000 truncated
       and the retry re-ran the entire call at 48,000, turning a 40-second job into 97.
       A retry here is not a cheap correction, it is doing everything twice. Unused budget
       costs nothing — only emitted tokens are billed. */
    maxTokens: 32000,
    timeoutMs: 180_000,
  });
  if (!result) return null;

  const rows = Array.isArray(result.value.brands) ? (result.value.brands as RawVerdict[]) : [];
  const verdicts: AiBrandVerdict[] = [];

  for (const row of rows) {
    const name = String(row?.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) continue;

    const tier = String(row?.tier ?? '').toLowerCase().replace(/[\s-]/g, '_');
    if (!['rare', 'common', 'not_worthy', 'unsorted'].includes(tier)) continue;

    const models = (Array.isArray(row?.models) ? row.models : [])
      .map((m) => String(m ?? '').replace(/\s+/g, ' ').trim())
      .filter((m) => m.length >= 2 && m.length <= 60)
      .slice(0, 20);

    const lookFor = (row?.lookFor === null || row?.lookFor === undefined ? '' : String(row.lookFor))
      .replace(/\s+/g, ' ')
      .trim();

    // A common brand nobody can describe is not a common brand.
    let finalTier: AiTier =
      tier === 'common' && isVague(lookFor, models) ? 'unsorted' : (tier as AiTier);

    /* The guard. A verdict resting on one or two sales describes those sales, not the
       brand — in either direction, so a thin "rare" is withheld as readily as a thin
       "not_worthy". The brand still gets a row, and its sales still accumulate. */
    if (finalTier !== 'unsorted' && evidenceFor(name, listings) < MIN_EVIDENCE) {
      finalTier = 'unsorted';
    }

    verdicts.push({
      name,
      tier: finalTier,
      models: finalTier === 'common' ? models : [],
      lookFor: finalTier === 'common' ? lookFor : null,
      reasoning: String(row?.reasoning ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }

  return verdicts;
}

/**
 * Classify every brand in a scan.
 *
 * Returns null when the model is unavailable — NOT an empty array, because "no brands
 * found" and "there was no AI" must lead the caller to different behaviour.
 */
export async function classifyListings(listings: AiListing[]): Promise<AiBrandVerdict[] | null> {
  if (!aiConfigured()) return null;

  const priced = listings.filter(
    (l) => typeof l.sold_price === 'number' && Number.isFinite(l.sold_price) && l.sold_price > 0,
  );
  if (!priced.length) return [];

  if (priced.length <= MAX_PER_CALL) return classifyChunk(priced);

  /* Only for a batch bigger than any single scan produces. Each chunk sees a whole slice
     rather than a stratum, so a brand's cheap and dear sales stay together. */
  const chunks: AiListing[][] = [];
  for (let i = 0; i < priced.length; i += MAX_PER_CALL) {
    chunks.push(priced.slice(i, i + MAX_PER_CALL));
  }

  const results = await Promise.all(chunks.map((chunk) => classifyChunk(chunk)));
  if (results.every((r) => r === null)) return null;
  return results.flatMap((r) => r ?? []);
}
