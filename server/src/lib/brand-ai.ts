/**
 * Classify a scan's sold listings into Rare / Common / Not worthy / Unsorted, in ONE call.
 *
 * The whole batch goes over together, and that is the design rather than an economy: a
 * brand's cheap sales and its dear ones only mean something beside each other, and a call
 * per fragment would see neither pattern — at ten times the cost.
 *
 * WHERE THE JUDGEMENT COMES FROM, which changed and matters:
 *
 * The model classifies from what it already knows about the resale market, using these
 * listings as SUPPORTING evidence — to identify which models carry a brand, and to confirm
 * what sells. An earlier version did the reverse, judging purely from the batch, and it
 * produced exactly the failure that invites: a boot seen once, selling for $600, filed as
 * "not worth picking up", because a single sale cannot demonstrate consistency.
 *
 * That is also why there is no minimum-sales rule here any more. A scan is a keyhole view
 * of a brand, and withholding judgement until the keyhole widens throws away knowledge the
 * model already has. `unsorted` now means the honest thing — a brand the model does not
 * know — which is a far smaller category than "a brand I only saw twice".
 *
 * FAILURE IS NOT FATAL. Returning null leaves the caller with the statistical scorer,
 * which needs no third party. An import must never die because an API is down.
 */
import { chatJSON, aiConfigured } from './llm.js';

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
 * Listings per call. The batch is meant to go over whole; this only exists so a scan far
 * larger than a normal page cannot blow the context window.
 */
const MAX_PER_CALL = 250;

const SYSTEM = `Analyze these eBay SOLD listings and identify every brand represented.

Classify each brand based primarily on your existing knowledge of the brand and the resale market. Use the sold listings as additional evidence to help identify valuable models, lines, and patterns.

The sold listings are examples of what sold. They are NOT necessarily representative of the entire brand and should not override established resale knowledge.

Classify every brand as:

### RARE

The BRAND itself is the pickup signal.

If seeing the brand name at a thrift store would normally make an experienced reseller stop and inspect the item, classify it as Rare.

Rare does NOT mean every item from the brand sells for a high price. Different models can still perform differently.

The question is simply:

**Is this brand itself strong enough in the resale market that the brand name alone makes the item worth inspecting?**

If yes → Rare.

### COMMON

The BRAND itself is not enough to make the item worth picking up or inspecting.

However, specific models, lines, materials, vintage versions, collaborations, or special variants are worth looking for.

If the reseller needs to know WHICH MODEL it is before the brand becomes interesting:

→ Common.

For every Common brand, provide exactly what to look for.

### NOT WORTHY

The brand itself is not worth intentionally sourcing AND there are no meaningful models or versions worth specifically looking for.

### UNSORTED

Use only when you genuinely do not know enough about the brand to classify it.

### CORE RULE

Do NOT ask:

"Is every item from this brand valuable?"

Instead ask:

**"If I saw this brand while sourcing at a thrift store, would the BRAND NAME ALONE make me stop and inspect the item?"**

YES → RARE

NO, but specific models are worth looking for → COMMON

NO, and there are no meaningful models worth looking for → NOT WORTHY

I don't know enough about the brand → UNSORTED

Use your existing resale-market knowledge to make this decision.

Use the supplied sold listings to SUPPORT the decision and identify models — not as the sole definition of the brand.

Return JSON only:

{
"brands": [
{
"name": "Brand Name",
"tier": "rare | common | not_worthy | unsorted",
"models": [],
"lookFor": null,
"reasoning": "Brief reason"
}
]
}

For Common brands, always populate \`models\` and \`lookFor\`.

Keep reasoning short.`;

interface RawVerdict {
  name?: unknown;
  tier?: unknown;
  models?: unknown;
  lookFor?: unknown;
  reasoning?: unknown;
}

/**
 * A name the model was not actually sure of.
 *
 * gpt-5-nano signals doubt inline rather than using the `unsorted` tier it was given —
 * "Burton??", "AldEN??", "Jumpman Swift??". Those are not brands, they are the model
 * thinking out loud, and a brand book full of question marks is worse than a shorter one.
 */
function isUncertainName(name: string): boolean {
  return /[?*]/.test(name) || /^(unknown|unclear|n\/?a|none|other)$/i.test(name);
}

/**
 * A row that is not a brand at all.
 *
 * Smaller models answer with pieces of the input instead of the brand behind it — an
 * entire listing title ("Belleville 770 Men's Leather Insulated Duty Combat Boots"), a
 * parenthetical gloss ("Birkenstock (suede loafer)"), or a category standing in for a name
 * ("Roper/Western boot brands not separately listed"). Each becomes a junk row that
 * shadows the real brand, so they are rejected before they reach the book.
 */
function isNotABrand(name: string): boolean {
  if (/[()[\]]/.test(name)) return true;
  if (/\b(brands?|others?|misc|various|related|not separately|unlisted|etc)\b/i.test(name)) return true;
  if (/[/,]/.test(name)) return true;
  // Real brand names are short. Four words is already generous — anything longer is a
  // listing title wearing a brand's clothes.
  if (name.split(' ').length > 4) return true;
  return false;
}

/**
 * Strip the lead-in the model keeps writing into the description.
 *
 * The page already renders "Look for:" before this text, so "Look for: Look for vintage
 * Dingo boots…" is what the user actually sees. The instruction is in the prompt; the
 * model ignores it often enough to be worth removing here.
 */
function stripLookForLeadIn(text: string): string {
  return text
    .replace(/^(look for|stop for|inspect(?: when| for)?|check(?: closely)?(?: for)?|watch for|seek out)\b[:,]?\s*/i, '')
    .replace(/^\(\d\)\s*/, '')
    .trim();
}

/**
 * Remove a stray token the model glued to the front of a name.
 *
 * gpt-5-nano occasionally emits a false start before the brand — "Drew: Dr Martens",
 * "MLaybe: HOKA One One", "Carpe: COLE HAAN". The brand after the colon is correct; the
 * word before it is noise, and left in place it becomes a second row for a brand the book
 * already has.
 */
function stripNamePrefix(name: string): string {
  return name.replace(/^[A-Za-z]{1,10}:\s*/, '').trim();
}

/** Price first, so the number leads every line. */
const asLine = (l: AiListing): string =>
  `$${l.sold_price ?? '?'} ${String(l.title ?? '').replace(/\s+/g, ' ').trim()}`;

/**
 * Text that only gestures at quality.
 *
 * A Common row IS its "look for" line — the brand name above it is only a heading — so
 * "premium models" reaching the book would read as an endorsement of everything the brand
 * makes. Such a row is filed unsorted, which is a question rather than a wrong answer.
 */
function isVague(lookFor: string, models: string[]): boolean {
  if (lookFor.length < 6) return true;
  if (models.length > 0) return false;
  return /^(premium|higher[- ]?end|various|several|certain|specific|good|nice|better|quality)\b/i
    .test(lookFor);
}

/** One call. Returns the brands it could identify, or null if the model was unusable. */
async function classifyChunk(listings: AiListing[]): Promise<AiBrandVerdict[] | null> {
  const result = await chatJSON<{ brands?: unknown }>({
    system: SYSTEM,
    user: `Here are the sold listings:\n\n${JSON.stringify({ listings: listings.map(asLine) }, null, 2)}`,
    /* Sized so ONE call suffices. The cap covers reasoning as well as the answer, and a
       retry is not a cheap correction here — it repeats the entire call. */
    maxTokens: 32000,
    timeoutMs: 180_000,
  });
  if (!result) return null;

  const rows = Array.isArray(result.value.brands) ? (result.value.brands as RawVerdict[]) : [];
  const verdicts: AiBrandVerdict[] = [];

  for (const row of rows) {
    const name = stripNamePrefix(String(row?.name ?? '').replace(/\s+/g, ' ').trim());
    if (name.length < 2 || name.length > 60) continue;
    // A colon still present means the prefix was not a simple false start; do not guess.
    if (name.includes(':')) continue;
    if (isUncertainName(name) || isNotABrand(name)) continue;

    const tier = String(row?.tier ?? '').toLowerCase().replace(/[\s-]/g, '_');
    if (!['rare', 'common', 'not_worthy', 'unsorted'].includes(tier)) continue;

    const models = (Array.isArray(row?.models) ? row.models : [])
      .map((m) => String(m ?? '').replace(/\s+/g, ' ').trim())
      .filter((m) => m.length >= 2 && m.length <= 60)
      .slice(0, 20);

    const lookFor = stripLookForLeadIn(
      (row?.lookFor === null || row?.lookFor === undefined ? '' : String(row.lookFor))
        .replace(/\s+/g, ' ')
        .trim(),
    );

    const finalTier: AiTier =
      tier === 'common' && isVague(lookFor, models) ? 'unsorted' : (tier as AiTier);

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

  const chunks: AiListing[][] = [];
  for (let i = 0; i < priced.length; i += MAX_PER_CALL) {
    chunks.push(priced.slice(i, i + MAX_PER_CALL));
  }

  const results = await Promise.all(chunks.map((chunk) => classifyChunk(chunk)));
  if (results.every((r) => r === null)) return null;
  return results.flatMap((r) => r ?? []);
}
