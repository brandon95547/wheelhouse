/**
 * Which models carry a common brand?
 *
 * A common brand is only worth recording if we can say what to look for under it, and
 * the honest source for that is the same one the tier came from: the sales themselves.
 * Split a brand's listings at the price that makes a pickup worthwhile, and the words
 * that appear far more often ABOVE the line than below it are the models that pay.
 *
 * This is a lift calculation, not a frequency count, and the difference is the whole
 * point. "Mens" appears in nearly every Nike listing, cheap and expensive alike, so it
 * is frequent but tells you nothing. "Dunk" appears in a quarter of the expensive ones
 * and almost none of the cheap ones. Ranking by frequency surfaces the first; ranking by
 * lift surfaces the second.
 *
 * What comes out is a suggestion, always. It is shown to a person before it is stored,
 * because a token that correlates with price is not necessarily a model — a good year,
 * a hyped colourway and a lucky word all look identical to this arithmetic.
 */

/** Words that describe any shoe rather than a model. Removed before anything is counted. */
const NOISE = new Set([
  'mens', 'men', 'mans', 'womens', 'women', 'unisex', 'kids', 'youth', 'boys', 'girls',
  'size', 'sz', 'us', 'uk', 'eu', 'eur', 'wide', 'narrow', 'medium', 'width',
  'new', 'nwt', 'nwob', 'nib', 'nwot', 'euc', 'used', 'preowned', 'pre', 'owned', 'worn',
  'excellent', 'great', 'good', 'condition', 'clean', 'authentic', 'genuine', 'real',
  'rare', 'vtg', 'htf', 'euc', 'deadstock', 'ds', 'og',
  'black', 'white', 'brown', 'blue', 'red', 'green', 'grey', 'gray', 'tan', 'navy',
  'beige', 'cream', 'pink', 'purple', 'yellow', 'orange', 'silver', 'gold', 'multi',
  'shoes', 'shoe', 'boots', 'boot', 'sneakers', 'sneaker', 'trainers', 'trainer',
  'loafers', 'loafer', 'sandals', 'sandal', 'heels', 'heel', 'flats', 'flat', 'pumps',
  'oxfords', 'oxford', 'chukka', 'lace', 'up', 'slip', 'on', 'low', 'high', 'top', 'mid',
  'the', 'and', 'with', 'for', 'in', 'of', 'a', 'no', 'box', 'lot', 'pair', 'style',
  'free', 'shipping', 'fast', 'nice', 'vguc',
]);

/** Tokens that are only ever a size or a year, never a model. */
function isNumericNoise(token: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(token)) return false;
  const n = Number(token);
  // Shoe sizes and years. Genuine numeric models (990, 1460, 574) fall outside both.
  return n <= 20 || (n >= 1900 && n <= 2100);
}

function tokenise(title: string, brandWords: Set<string>): string[] {
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2 && w.length <= 20)
    .filter((w) => !NOISE.has(w) && !isNumericNoise(w))
    // The brand's own name is in every listing by construction and carries no signal.
    .filter((w) => !brandWords.has(w));
}

export interface MinedModel {
  name: string;
  /** How many of the brand's ABOVE-the-line sales contain this token. */
  hits: number;
  /** Share of above-line sales, 0..1. */
  coverage: number;
  /** How much more likely this token is above the line than below it. */
  lift: number;
  medianPrice: number | null;
}

export interface MiningOptions {
  /** The price that separates a worthwhile pickup from a waste of a trip. */
  line?: number;
  /** Minimum above-line listings containing a token before it can be suggested. */
  minHits?: number;
  /** Minimum lift. 2 means "twice as common above the line as below it". */
  minLift?: number;
  limit?: number;
}

/**
 * Find the model tokens that distinguish a brand's valuable sales from its cheap ones.
 *
 * Returns [] rather than guessing when the evidence is thin — which is the behaviour the
 * brand book depends on, since a common brand with no models found must stay unsorted
 * rather than be filed with an empty description.
 */
export function mineModels(
  listings: Array<{ title: string; sold_price: number | null }>,
  brandName: string,
  options: MiningOptions = {},
): MinedModel[] {
  const { line = 50, minHits = 3, minLift = 2, limit = 8 } = options;

  const brandWords = new Set(
    brandName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean),
  );

  const above: string[][] = [];
  const below: string[][] = [];
  const pricesByToken = new Map<string, number[]>();

  for (const listing of listings) {
    const price = listing.sold_price;
    if (typeof price !== 'number' || !Number.isFinite(price)) continue;
    const ordered = tokenise(listing.title, brandWords);
    // Adjacent pairs as well as single words, so "sb dunk" and "air jordan" survive as
    // the models they are instead of arriving as loose words that read like a shopping
    // list. Suppression below drops whichever form is redundant.
    const bigrams = ordered.slice(0, -1).map((word, i) => `${word} ${ordered[i + 1]}`);
    const terms = [...new Set([...ordered, ...bigrams])];

    if (price >= line) {
      above.push(terms);
      for (const term of terms) {
        const list = pricesByToken.get(term) ?? [];
        list.push(price);
        pricesByToken.set(term, list);
      }
    } else {
      below.push(terms);
    }
  }

  // Nothing above the line means nothing to look for, whatever the token counts say.
  if (above.length < minHits) return [];

  const countIn = (corpus: string[][]) => {
    const counts = new Map<string, number>();
    for (const tokens of corpus) for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  };

  const aboveCounts = countIn(above);
  const belowCounts = countIn(below);

  const mined: MinedModel[] = [];
  for (const [token, hits] of aboveCounts) {
    if (hits < minHits) continue;

    const coverage = hits / above.length;
    const belowRate = below.length ? (belowCounts.get(token) ?? 0) / below.length : 0;
    // No below-line sales to compare against means no evidence of discrimination, so the
    // token is credited with its coverage rather than an infinite lift.
    const lift = belowRate > 0 ? coverage / belowRate : below.length === 0 ? 1 : Infinity;
    if (lift < minLift) continue;

    const prices = (pricesByToken.get(token) ?? []).sort((a, b) => a - b);
    const median = prices.length
      ? prices.length % 2
        ? prices[(prices.length - 1) / 2]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : null;

    mined.push({
      name: token,
      hits,
      coverage: Math.round(coverage * 1000) / 1000,
      lift: Number.isFinite(lift) ? Math.round(lift * 100) / 100 : 99,
      medianPrice: median === null ? null : Math.round(median * 100) / 100,
    });
  }

  // "sb dunk" beats "sb" and "dunk" when the pair explains nearly all of each word's
  // hits — the phrase is the model, and the halves are noise once it is present. Kept
  // separate when a word also appears alone often ("jordan" without "air jordan"), since
  // then both are really being used.
  const ranked = mined.sort((a, b) => b.lift - a.lift || b.hits - a.hits);

  // Overlapping phrases describe one model, not several: "sb dunk", "dunk pro" and
  // "dunk low" are the same shoe seen through three windows. Keep the best-ranked phrase
  // and drop any later one sharing a word with it, so the line reads as a list of models
  // rather than a slice of every title they appeared in.
  // Subsumption is judged against EVERY phrase, not only the ones that survive the
  // overlap pass. "pro" is explained by "dunk pro" even when "dunk pro" itself is
  // dropped for overlapping "sb dunk" — dropping the phrase must not resurrect the word.
  const subsumed = new Set<string>();
  for (const phrase of ranked) {
    if (!phrase.name.includes(' ')) continue;
    for (const word of phrase.name.split(' ')) {
      const single = ranked.find((m) => m.name === word);
      if (single && phrase.hits >= single.hits * 0.8) subsumed.add(word);
    }
  }

  const kept: MinedModel[] = [];
  const claimed = new Set<string>();
  for (const term of ranked) {
    if (subsumed.has(term.name)) continue;
    const words = term.name.split(' ');
    if (words.length > 1) {
      if (words.some((w) => claimed.has(w))) continue;
      words.forEach((w) => claimed.add(w));
    }
    kept.push(term);
  }

  return kept.slice(0, limit);
}

/** The mined models as the "Look for:" line the brand book stores. */
export function lookForFromModels(models: MinedModel[]): string | null {
  if (!models.length) return null;
  return models.map((m) => m.name).join(', ');
}
