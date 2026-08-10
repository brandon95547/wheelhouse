/**
 * Classify a batch of imported sold listings into Rare / Common / Not worthy.
 *
 * TWO PASSES, BECAUSE THE TWO HARD PARTS ARE HARD IN DIFFERENT WAYS.
 *
 *   Pass 1  EXTRACTION — read the titles, return the brand names present.
 *           A language problem. "Nke Air Jordn 1 Retro sz10 mens DS" is Nike to any
 *           reader and defeats every rule anyone wants to write. This is what the model
 *           is actually being paid for.
 *
 *   (code)  ATTRIBUTION AND ARITHMETIC — match listings to those names and compute the
 *           median, quartile and price shares. Once the NAMES are known, matching them is
 *           trivial, and percentiles over two hundred numbers are something a model
 *           cannot do reliably and a computer cannot do wrong.
 *
 *   Pass 2  JUDGEMENT — given each brand's real statistics AND its titles, answer the
 *           three questions that decide the tier, and write the "Look for" line.
 *           Interpreting numbers is fair to ask; deriving them is not.
 *
 * The split matters. A single pass asking "read these 200 listings and tell me if the
 * value is consistent" gets a fluent answer built on arithmetic the model guessed at,
 * and the whole point of the tier is that it is trustworthy.
 *
 * FAILURE IS NOT FATAL. Any pass returning null leaves the caller with the statistical
 * scorer, which needs no third party and was working before this file existed.
 */
import { chatJSON, aiConfigured } from './deepseek.js';
import { scoreBrand, type BrandStats } from './brand-strength.js';
import { normaliseBrand } from './brands.js';

export interface AiListing {
  title: string;
  sold_price: number | null;
}

export type AiTier = 'rare' | 'common' | 'not_worthy';

export interface AiBrandVerdict {
  name: string;
  tier: AiTier;
  /** The specific models worth picking up under a common brand. Empty for other tiers. */
  models: string[];
  lookFor: string | null;
  reasoning: string;
  stats: BrandStats;
  listingCount: number;
}

/** Batching keeps one prompt inside a sane context and one failure cheap. */
const EXTRACT_BATCH = 120;
/** Titles shown per brand in pass 2. Enough to see the models; not the whole corpus. */
const TITLE_SAMPLE = 40;
/** Below this many sales a brand is not put to the model at all — see scoreBrand. */
const MIN_FOR_JUDGEMENT = 8;
/** Brands judged per call. A scan can turn up hundreds; one prompt cannot hold them. */
const JUDGE_BATCH = 10;

const EXTRACT_SYSTEM = `You identify BRAND NAMES in eBay listing titles for resale items.

Return JSON in this shape:
{"brands": [{"name": "<canonical brand name>", "variants": ["<spelling as it appears>", ...]}]}

For each brand, "variants" must list EVERY spelling, misspelling, abbreviation and
sub-line that actually appears in the titles you were given for that brand. This is the
most important part of your answer: it is used to match listings back to the brand, and a
spelling you omit means that listing is silently dropped from the brand's sales figures.

Rules:
- "name" is the brand's canonical name, correctly spelled, as a reseller would write it.
  Use the full name when the brand has a longer official form rather than a short prefix.
- "variants" must be lowercase, and each must be a literal run of words that appears in at
  least one of the titles given. Include the correct spelling too. Include dropped
  letters, missing punctuation, phonetic misspellings, and initialisms — whatever the
  sellers actually typed.
- Include a sub-line or sub-brand as a variant ONLY when the parent brand name is absent
  from those titles and the sub-line is what sellers write instead.
- Do not invent variants that do not appear in the titles.
- One entry per distinct brand. Do not repeat.
- Skip listings with no identifiable brand. Never invent a brand.
- Do not include "Unbranded", "Handmade", "Vintage" or similar non-brands.

The titles may be footwear, clothing, accessories or anything else. Judge only from what
is in front of you.`;

const JUDGE_SYSTEM = `You are helping a thrift-store reseller decide what is worth picking up.

For each brand you get real statistics from its SOLD listings — median, lower quartile, top
decile, and the share of sales clearing $40/$50/$60/$100 — plus its highest-selling titles
with prices. Trust the statistics; they are already computed. Then answer one question:

  If I found a random item from this brand in a thrift store, is it worth picking up?

  "rare"        Yes, whatever it is. Value holds across the whole brand, not just a few
                models — a plain example is still worth money.
  "common"      Only certain ones. The brand alone means nothing, but specific models,
                lines, materials, eras, countries of make, collaborations or special
                variants sell well. Say which.
  "not_worthy"  No. It does not sell for enough to justify picking up, and you cannot
                identify any specific version that does.

For a "common" brand the real work is saying WHICH items are worth it. Compare the titles
that sold high against those that sold cheap and name what the expensive ones have in
common.

Return JSON in this shape:
{"brands":[{
  "name":"<brand name exactly as given to you>",
  "tier":"rare" | "common" | "not_worthy",
  "models":["<model or line worth buying>", ...],
  "lookFor":"<one line a person reads in a store>",
  "reasoning":"<one short sentence>"
}]}

Rules:
- "common" requires "models" and "lookFor". Use the short name a reseller would say, not
  the full listing title. "lookFor" is the one line someone reads while holding the item.
- Never answer "common" with vague text like "premium models" or "certain styles". If you
  cannot name a specific model or a specific kind of item, answer "not_worthy".
- "rare" takes "models": [] and "lookFor": null — the brand alone is the signal.
- Copy "name" exactly as given. Never rename or merge brands.
- Judge only from the data in front of you. Do not let a brand's reputation override weak
  sales, and never carry one brand's models over to another.`;

/**
 * Pass 1 — the brand names present in a batch of titles.
 *
 * Returns [] rather than null on failure so the caller can proceed with whatever other
 * batches succeeded; a partial extraction is still better than none.
 */
export interface ExtractedBrand {
  name: string;
  variants: string[];
}

async function extractBrandNames(listings: AiListing[]): Promise<ExtractedBrand[]> {
  const byName = new Map<string, Set<string>>();

  for (let i = 0; i < listings.length; i += EXTRACT_BATCH) {
    const batch = listings.slice(i, i + EXTRACT_BATCH);
    const result = await chatJSON<{ brands?: unknown }>({
      system: EXTRACT_SYSTEM,
      user: JSON.stringify({ titles: batch.map((l) => l.title) }),
      maxTokens: 6000,
    });
    if (!result) continue;

    const returned = Array.isArray(result.value.brands) ? result.value.brands : [];
    for (const raw of returned) {
      const row = (raw ?? {}) as { name?: unknown; variants?: unknown };
      const name = String(row.name ?? '').replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 60) continue;

      const variants = byName.get(name) ?? new Set<string>();
      // The canonical name is always a variant of itself; the model sometimes omits it.
      variants.add(normaliseBrand(name));
      for (const v of Array.isArray(row.variants) ? row.variants : []) {
        const slug = normaliseBrand(v);
        // One- and two-character variants match half the corpus by accident.
        if (slug.length >= 2) variants.add(slug);
      }
      byName.set(name, variants);
    }
  }

  return [...byName.entries()].map(([name, variants]) => ({ name, variants: [...variants] }));
}

/**
 * Attribute listings to brand names by word-boundary match.
 *
 * Longest name first so "Polo Ralph Lauren" is never swallowed by "Ralph Lauren". This is
 * the same match the rest of the app uses; it is reliable precisely because the model has
 * already done the hard half by producing the correct name.
 */
export function groupByBrandName(
  listings: AiListing[],
  brands: ExtractedBrand[],
): Map<string, AiListing[]> {
  // Every variant becomes its own needle pointing back at the canonical name. Longest
  // first so "polo ralph lauren" beats "ralph lauren", and — the reason this exists —
  // so "nke" catches the misspelled listings that would otherwise vanish from the
  // brand's figures and leave only its correctly-spelled, expensive ones behind.
  const needles = brands
    .flatMap((brand) =>
      brand.variants.map((variant) => ({
        name: brand.name,
        words: variant.split(' ').filter(Boolean),
      })),
    )
    .filter((entry) => entry.words.length > 0)
    .sort((a, b) => b.words.length - a.words.length);

  const grouped = new Map<string, AiListing[]>();
  for (const listing of listings) {
    const words = normaliseBrand(listing.title).split(' ').filter(Boolean);
    for (const { name, words: needle } of needles) {
      let hit = false;
      for (let i = 0; i + needle.length <= words.length && !hit; i += 1) {
        hit = needle.every((w, k) => words[i + k] === w);
      }
      if (hit) {
        const list = grouped.get(name) ?? [];
        list.push(listing);
        grouped.set(name, list);
        break;
      }
    }
  }
  return grouped;
}

/** The compact per-brand brief pass 2 reasons over. */
function brief(name: string, listings: AiListing[], stats: BrandStats) {
  // Highest first: the models that carry a brand are the ones worth showing, and a
  // truncated sample of cheap listings would hide exactly what pass 2 is looking for.
  const sample = [...listings]
    .sort((a, b) => (b.sold_price ?? 0) - (a.sold_price ?? 0))
    .slice(0, TITLE_SAMPLE)
    .map((l) => `$${l.sold_price} ${l.title}`);

  return {
    name,
    totalSales: listings.length,
    median: stats.median,
    lowerQuartile: stats.lowerQuartile,
    topDecile: stats.topDecile,
    shareAtLeast: {
      $40: `${Math.round(stats.shareAt[40] * 100)}%`,
      $50: `${Math.round(stats.shareAt[50] * 100)}%`,
      $60: `${Math.round(stats.shareAt[60] * 100)}%`,
      $100: `${Math.round(stats.shareAt[100] * 100)}%`,
    },
    highestSales: sample,
  };
}

interface JudgedBrand {
  name?: unknown;
  tier?: unknown;
  models?: unknown;
  lookFor?: unknown;
  reasoning?: unknown;
}

/**
 * Classify every brand found in a batch of listings.
 *
 * Returns null when the model is unavailable — NOT an empty array, because "the AI found
 * no brands" and "there was no AI" must lead to different behaviour in the caller.
 */
export async function classifyListings(listings: AiListing[]): Promise<AiBrandVerdict[] | null> {
  if (!aiConfigured()) return null;

  const priced = listings.filter((l) => typeof l.sold_price === 'number' && l.sold_price > 0);
  if (!priced.length) return [];

  const extracted = await extractBrandNames(priced);
  if (!extracted.length) return null;

  const grouped = groupByBrandName(priced, extracted);

  // Thin brands are withheld from pass 2 entirely. Asking for a verdict on four sales
  // invites a confident answer about a sample rather than a brand.
  const judgeable = [...grouped.entries()].filter(([, ls]) => ls.length >= MIN_FOR_JUDGEMENT);
  if (!judgeable.length) return [];

  const statsByName = new Map(judgeable.map(([name, ls]) => [
    name,
    scoreBrand(ls.map((l) => l.sold_price as number)),
  ]));

  /* Judged in batches. A single prompt holding three hundred brands would exceed the
     context and lose the whole scan to one failure; batching also means a brand that
     confuses the model costs nine neighbours rather than everything. */
  const returned: JudgedBrand[] = [];
  let anySucceeded = false;

  for (let i = 0; i < judgeable.length; i += JUDGE_BATCH) {
    const slice = judgeable.slice(i, i + JUDGE_BATCH);
    const result = await chatJSON<{ brands?: unknown }>({
      system: JUDGE_SYSTEM,
      user: JSON.stringify({
        brands: slice.map(([name, ls]) => brief(name, ls, statsByName.get(name)!)),
      }),
      maxTokens: 4000,
    });
    if (!result) continue;
    anySucceeded = true;
    if (Array.isArray(result.value.brands)) returned.push(...(result.value.brands as JudgedBrand[]));
  }

  // Every batch failing is indistinguishable from having no AI, and must fall back
  // rather than look like "the model found nothing".
  if (!anySucceeded) return null;

  const verdicts: AiBrandVerdict[] = [];

  for (const row of returned) {
    const name = String(row?.name ?? '').trim();
    const listingsForBrand = grouped.get(name);
    // A name the model invented in pass 2 has no listings behind it and no place in the
    // book. Silently dropping it is right: it is a hallucination, not a finding.
    if (!name || !listingsForBrand) continue;

    const tier = String(row?.tier ?? '').toLowerCase();
    if (tier !== 'rare' && tier !== 'common' && tier !== 'not_worthy') continue;

    const lookForRaw = row?.lookFor === null || row?.lookFor === undefined ? '' : String(row.lookFor);
    const lookFor = lookForRaw.replace(/\s+/g, ' ').trim();

    // The rule the rest of the app enforces, applied to the model's output too: a common
    // brand it could not describe is downgraded rather than stored as a bare famous name.
    const models = (Array.isArray(row?.models) ? row.models : [])
      .map((m) => String(m ?? '').replace(/\s+/g, ' ').trim())
      .filter((m) => m.length >= 2 && m.length <= 60)
      .slice(0, 20);

    // A common brand has to name something. Text that only gestures at quality — with no
    // model and no describable kind of item behind it — is the failure this downgrade
    // exists to catch, because it reads as an endorsement of the whole brand.
    const vague =
      lookFor.length < 6 ||
      (models.length === 0 && /^(premium|various|several|certain|specific|good|nice)\b/i.test(lookFor));
    const finalTier: AiTier = tier === 'common' && vague ? 'not_worthy' : (tier as AiTier);

    verdicts.push({
      name,
      tier: finalTier,
      models: finalTier === 'common' ? models : [],
      lookFor: finalTier === 'common' ? lookFor : null,
      reasoning: String(row?.reasoning ?? '').slice(0, 400),
      stats: statsByName.get(name)!,
      listingCount: listingsForBrand.length,
    });
  }

  return verdicts;
}
