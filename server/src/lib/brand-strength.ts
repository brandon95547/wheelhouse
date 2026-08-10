/**
 * How consistently does a brand sell for money?
 *
 * THE QUESTION THIS ANSWERS, and the only one it tries to:
 *
 *   "If I find a random item from this brand in a thrift store, how likely is it to be
 *    worth taking to the till?"
 *
 * That is a question about CONSISTENCY, not ceiling. A brand with two $900 sales and
 * three hundred $12 sales is not a good brand — it is a bad brand with a lottery ticket
 * in it — and any statistic that lets those two sales speak for the other three hundred
 * gives exactly the wrong answer to someone standing in an aisle.
 *
 * So the mean is never used. Everything here is a rank statistic: the median, the lower
 * quartile, and the share of sales clearing a price. Those cannot be moved by an outlier,
 * which is the entire reason they were chosen. A single $2,000 sale shifts the mean of a
 * hundred listings by $20 and shifts the median by nothing at all.
 *
 * THE TIERS FALL OUT OF THE DISTRIBUTION'S SHAPE:
 *
 *   rare      A high floor. The lower quartile alone clears what a pickup has to earn,
 *             so a random example is worth having. The brand is the signal.
 *   common    A low floor with a real tail. Most examples are worthless, some are not,
 *             which means the MODEL is the signal — and a common brand is only worth
 *             recording if we can also say which models those are.
 *   (neither) A low floor and no tail. Nothing here pays. Not recorded at all: a brand
 *             book that lists brands worth nothing is a brand book nobody trusts.
 */

/** Sorted ascending. Every statistic below assumes this and none of them re-sorts. */
function ascending(prices: number[]): number[] {
  return prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
}

/**
 * The p-th percentile by linear interpolation between order statistics.
 *
 * Interpolated rather than nearest-rank because the samples are small: with 14 sales the
 * nearest-rank quartile jumps in visible steps as one listing is added, which makes a
 * brand look like it changed when only the sample did.
 */
export function percentile(sortedPrices: number[], p: number): number | null {
  if (!sortedPrices.length) return null;
  if (sortedPrices.length === 1) return round(sortedPrices[0]);
  const rank = (p / 100) * (sortedPrices.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const value =
    low === high
      ? sortedPrices[low]
      : sortedPrices[low] + (sortedPrices[high] - sortedPrices[low]) * (rank - low);
  return round(value);
}

/** The share of sales at or above a price, 0..1. The consistency measure. */
export function shareAtLeast(sortedPrices: number[], threshold: number): number {
  if (!sortedPrices.length) return 0;
  // Sorted ascending, so everything from the first qualifying index onward qualifies.
  const firstAtOrAbove = sortedPrices.findIndex((p) => p >= threshold);
  if (firstAtOrAbove === -1) return 0;
  return round((sortedPrices.length - firstAtOrAbove) / sortedPrices.length, 4);
}

const round = (value: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
};

/**
 * The gates a brand must clear to be worth picking up on the label alone.
 *
 * Read them together: a good median says the typical sale is worth having, a good lower
 * quartile says the BAD sales are still worth having, and the 70% share says that is
 * true reliably rather than on average. A brand can pass any one of these on luck; it
 * cannot pass all three without actually being consistent.
 */
export const RARE_GATES = {
  medianAtLeast: 60,
  lowerQuartileAtLeast: 40,
  shareAtLeast: { price: 50, fraction: 0.7 },
};

/**
 * What a common brand's tail has to look like before the brand is worth recording.
 *
 * Deliberately not symmetrical with the rare gates. A brand is worth putting in the book
 * as "check the model" only if checking the model can actually pay — one lucky sale in
 * two hundred is not a reason to pick anything up.
 */
export const COMMON_GATES = {
  topDecileAtLeast: 60,
  shareAtLeast: { price: 50 as 40 | 50 | 60 | 100, fraction: 0.12 },
};

/**
 * Below this many sales the gates are describing the sample, not the brand.
 *
 * Nine sales can put the lower quartile anywhere. Rather than publish a confident tier
 * built on noise, a thin brand stays unsorted and says so — the count is shown in the UI
 * precisely so a judgement can be deferred until the evidence arrives.
 */
export const MIN_SAMPLE = 12;

/** Above this, the gates are trustworthy enough to stop hedging in the UI. */
export const CONFIDENT_SAMPLE = 40;

export type Strength = 'rare' | 'common' | 'weak' | 'thin';

export interface BrandStats {
  sampleSize: number;
  median: number | null;
  lowerQuartile: number | null;
  topDecile: number | null;
  /** Share of sales at or above each price. The consistency profile, per the spec. */
  shareAt: { 40: number; 50: number; 60: number; 100: number };
  strength: Strength;
  confident: boolean;
  /** Plain-language reason, shown in the UI so a tier is never an unexplained verdict. */
  reason: string;
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * Score one brand from its actual sold prices.
 *
 * Takes raw prices, not a rollup: a median-of-medians cannot produce a quartile, and the
 * whole method depends on seeing the cheap sales that a summary has already discarded.
 */
export function scoreBrand(prices: number[]): BrandStats {
  const sorted = ascending(prices);
  const n = sorted.length;

  const shareAt = {
    40: shareAtLeast(sorted, 40),
    50: shareAtLeast(sorted, 50),
    60: shareAtLeast(sorted, 60),
    100: shareAtLeast(sorted, 100),
  };
  const median = percentile(sorted, 50);
  const lowerQuartile = percentile(sorted, 25);
  const topDecile = percentile(sorted, 90);

  const base = { sampleSize: n, median, lowerQuartile, topDecile, shareAt };

  if (n < MIN_SAMPLE) {
    return {
      ...base,
      strength: 'thin',
      confident: false,
      reason: `Only ${n} sale${n === 1 ? '' : 's'} on record — too few to judge the brand. Needs ${MIN_SAMPLE}.`,
    };
  }

  const confident = n >= CONFIDENT_SAMPLE;

  const passesMedian = (median ?? 0) >= RARE_GATES.medianAtLeast;
  const passesQuartile = (lowerQuartile ?? 0) >= RARE_GATES.lowerQuartileAtLeast;
  const passesShare = shareAt[50] >= RARE_GATES.shareAtLeast.fraction;

  if (passesMedian && passesQuartile && passesShare) {
    return {
      ...base,
      strength: 'rare',
      confident,
      reason:
        `Sells consistently: median $${median}, lower quartile $${lowerQuartile}, ` +
        `and ${pct(shareAt[50])} of ${n} sales cleared $50. A random example is worth having.`,
    };
  }

  const hasTail =
    (topDecile ?? 0) >= COMMON_GATES.topDecileAtLeast &&
    shareAt[COMMON_GATES.shareAtLeast.price] >= COMMON_GATES.shareAtLeast.fraction;

  if (hasTail) {
    // Name the gate that actually failed. "Did not qualify" tells the user nothing about
    // whether the brand is borderline or hopeless.
    const missed = !passesQuartile
      ? `the lower quartile is only $${lowerQuartile}`
      : !passesMedian
        ? `the median is only $${median}`
        : `only ${pct(shareAt[50])} of sales cleared $50`;
    return {
      ...base,
      strength: 'common',
      confident,
      reason:
        `Most sell cheap — ${missed} — but the top 10% reach $${topDecile}. ` +
        `Worth picking up only on the right model.`,
    };
  }

  return {
    ...base,
    strength: 'weak',
    confident,
    reason:
      `Does not sell: median $${median}, and only ${pct(shareAt[50])} of ${n} sales cleared $50. ` +
      `Nothing here is worth picking up.`,
  };
}
