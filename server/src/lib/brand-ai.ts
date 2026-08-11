/**
 * Read a scan's sold listings and report what is in it: which brands, and — for every
 * listing — which brand and model that listing actually is.
 *
 * THE MODEL IS A SEEKER, NOT AN EDITOR. It identifies things and hands them back. It does
 * not revise the book: a brand already in the book keeps the tier it has, and only the
 * user moves it. So the two halves of the answer are put to very different uses —
 *
 *   brands   a tier, used ONLY when the brand is new to this category. For a brand the
 *            book already holds it is read and discarded, every time, forever.
 *   items    per-listing brand + model attribution. Always used, for every brand in
 *            every tier, because a model is a fact about a listing rather than a
 *            judgement about a brand — and facts are what this call is trusted with.
 *
 * PER-LISTING, NOT PER-BRAND, and that is the change that makes models worth having. The
 * old call asked for a list of model names per brand and got plausible-sounding words with
 * nothing behind them. Asking instead what each individual shoe IS gives every model a
 * count and a median computed from the sales that carried it, and it collects models for
 * rare brands as readily as for common ones — the old shape could not, because it only
 * asked for models where it wanted a description.
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
  /** Models seen under this brand in THIS scan, gathered from the per-listing answers. */
  models: string[];
  lookFor: string | null;
  reasoning: string;
}

/** What one listing turned out to be. `index` refers to the numbered line it was given. */
export interface AiItemAttribution {
  index: number;
  brand: string;
  /** Null when the title names a brand but no readable model. */
  model: string | null;
}

export interface AiReading {
  brands: AiBrandVerdict[];
  items: AiItemAttribution[];
}

/**
 * Listings per call. The batch is meant to go over whole; this only exists so a scan far
 * larger than a normal page cannot blow the context window.
 */
const MAX_PER_CALL = 250;

/** Exported so the prompt can be dumped and run by hand without transcribing it. */
export const SYSTEM = `Analyze these eBay SOLD listings and identify every brand represented.

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

### THE MODEL OF EACH ITEM

Separately from the brand verdicts, identify what EACH numbered listing actually is.

Every listing gets one entry, using the number it was given.

- \`brand\` — the brand that made it, spelled the same way you spelled it above.
- \`model\` — the specific model, line or silhouette: "Air Max 90", "2002R", "1460", "Ghost Max". Strip the size, the colourway, the condition and the SKU. Return null if the title names no readable model.

Do this for EVERY brand in EVERY tier, Rare and Common alike. A Rare brand's models matter just as much as a Common brand's.

Return JSON only:

{
"brands": [
{
"name": "Brand Name",
"tier": "rare | common | not_worthy | unsorted",
"lookFor": null,
"reasoning": "Brief reason"
}
],
"items": [
{ "i": 0, "brand": "Brand Name", "model": "Model Name" },
{ "i": 1, "brand": "Brand Name", "model": null }
]
}

For Common brands, always populate \`lookFor\`.

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

/**
 * Price first, so the number leads every line; index first of all, so the answer can point
 * back at a listing without echoing its title. Numbering is per-call and starts at 0.
 */
const asLine = (l: AiListing, i: number): string =>
  `${i}. $${l.sold_price ?? '?'} ${String(l.title ?? '').replace(/\s+/g, ' ').trim()}`;

/**
 * Strip the things that are not the model.
 *
 * The prompt asks for this and mostly gets it, but "Air Max 90 Size 10" and "1460 (Black)"
 * come back often enough that leaving them would split one model across three rows.
 */
function cleanModel(value: unknown): string | null {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\((?:[^)]*)\)/g, ' ')                    // parenthetical glosses
    .replace(/\b(?:size|sz|us|uk|eu)\b[\s.:]*[\d.]+\s*/gi, ' ')
    .replace(/\b(?:mens?|womens?|unisex|youth|kids)\b/gi, ' ')
    .replace(/[^A-Za-z0-9 &'./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 2 || text.length > 60) return null;
  // "N/A", "unknown", a bare dash: the model saying it could not tell, in words.
  if (/^(n\/?a|unknown|unclear|none|other|various|model|generic|-+)$/i.test(text)) return null;
  // A model that is only a size or a year is a parsing failure, not a model.
  if (/^\d+(\.\d+)?$/.test(text) && (Number(text) <= 20 || Number(text) >= 1900)) return null;
  return text;
}

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

/** One call. Returns what it could read, or null if the model was unusable. */
async function classifyChunk(listings: AiListing[], offset: number): Promise<AiReading | null> {
  const result = await chatJSON<{ brands?: unknown; items?: unknown }>({
    system: SYSTEM,
    user: `Here are the sold listings:\n\n${listings.map(asLine).join('\n')}`,
    /* Sized so ONE call suffices. The cap covers reasoning as well as the answer, and a
       retry is not a cheap correction here — it repeats the entire call. */
    maxTokens: 32000,
    timeoutMs: 180_000,
  });
  if (!result) return null;

  const rows = Array.isArray(result.value.brands) ? (result.value.brands as RawVerdict[]) : [];
  const verdicts: AiBrandVerdict[] = [];

  /* Per-listing attributions, read first because the brand rows borrow from them.
   *
   * An index outside the chunk is dropped rather than clamped: a number the model invented
   * points at no listing, and attaching it to whichever listing sits at that position would
   * turn a hallucination into a stored fact. `offset` puts it back on the whole-scan
   * numbering, since each chunk is numbered from zero. */
  const items: AiItemAttribution[] = [];
  const modelsByBrand = new Map<string, Set<string>>();

  for (const raw of Array.isArray(result.value.items) ? (result.value.items as unknown[]) : []) {
    const row = raw as { i?: unknown; brand?: unknown; model?: unknown };
    const index = Number(row?.i);
    if (!Number.isInteger(index) || index < 0 || index >= listings.length) continue;

    const brand = stripNamePrefix(String(row?.brand ?? '').replace(/\s+/g, ' ').trim());
    if (brand.length < 2 || brand.length > 60) continue;
    if (brand.includes(':') || isUncertainName(brand) || isNotABrand(brand)) continue;

    const model = cleanModel(row?.model);
    items.push({ index: index + offset, brand, model });
    if (model) {
      const key = brand.toLowerCase();
      const set = modelsByBrand.get(key) ?? new Set<string>();
      set.add(model);
      modelsByBrand.set(key, set);
    }
  }

  for (const row of rows) {
    const name = stripNamePrefix(String(row?.name ?? '').replace(/\s+/g, ' ').trim());
    if (name.length < 2 || name.length > 60) continue;
    // A colon still present means the prefix was not a simple false start; do not guess.
    if (name.includes(':')) continue;
    if (isUncertainName(name) || isNotABrand(name)) continue;

    const tier = String(row?.tier ?? '').toLowerCase().replace(/[\s-]/g, '_');
    if (!['rare', 'common', 'not_worthy', 'unsorted'].includes(tier)) continue;

    /* Models come from the per-listing answers, never from the brand row. The model is no
       longer asked for a list of names in the abstract — it is asked what each shoe IS —
       so what lands here is backed by a listing that exists, and carries that listing's
       price with it. Kept for every tier, which is the point of the change. */
    const models = [...(modelsByBrand.get(name.toLowerCase()) ?? [])].slice(0, 20);

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
      models,
      lookFor: finalTier === 'common' ? lookFor : null,
      reasoning: String(row?.reasoning ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }

  /* A brand named only in the item rows still belongs in the answer.
   *
   * The two halves disagree more often than they should — a smaller model lists twenty
   * brands and attributes listings to twenty-three. The extra ones are real brands it read
   * off a title, and dropping them would mean an imported listing pointing at a brand the
   * book never created. They arrive `unsorted`, which is the honest tier for a brand that
   * was seen but never judged. */
  const judged = new Set(verdicts.map((v) => v.name.toLowerCase()));
  for (const [key, models] of modelsByBrand) {
    if (judged.has(key)) continue;
    const name = items.find((i) => i.brand.toLowerCase() === key)?.brand;
    if (!name) continue;
    verdicts.push({
      name,
      tier: 'unsorted',
      models: [...models].slice(0, 20),
      lookFor: null,
      reasoning: 'Seen in a listing but not classified.',
    });
  }

  return { brands: verdicts, items };
}

/**
 * Read every brand and every listing in a scan.
 *
 * Returns null when the model is unavailable — NOT an empty reading, because "nothing
 * found" and "there was no AI" must lead the caller to different behaviour.
 *
 * `items[].index` indexes THE ARRAY PASSED IN, so the caller can map an attribution back
 * to the listing row it came from. Unpriced listings are filtered out before the call and
 * would break that correspondence, so the surviving positions are carried alongside rather
 * than recomputed — an index into the filtered array would silently point at the wrong shoe.
 */
export async function classifyListings(listings: AiListing[]): Promise<AiReading | null> {
  if (!aiConfigured()) return null;

  const priced: AiListing[] = [];
  const originalIndex: number[] = [];
  listings.forEach((l, i) => {
    if (typeof l.sold_price === 'number' && Number.isFinite(l.sold_price) && l.sold_price > 0) {
      priced.push(l);
      originalIndex.push(i);
    }
  });
  if (!priced.length) return { brands: [], items: [] };

  const chunks: Array<{ listings: AiListing[]; offset: number }> = [];
  for (let i = 0; i < priced.length; i += MAX_PER_CALL) {
    chunks.push({ listings: priced.slice(i, i + MAX_PER_CALL), offset: i });
  }

  const results = await Promise.all(chunks.map((c) => classifyChunk(c.listings, c.offset)));
  if (results.every((r) => r === null)) return null;

  return {
    brands: results.flatMap((r) => r?.brands ?? []),
    // Back onto the caller's numbering, now that every chunk has been placed on the
    // filtered one.
    items: results
      .flatMap((r) => r?.items ?? [])
      .map((item) => ({ ...item, index: originalIndex[item.index] }))
      .filter((item) => item.index !== undefined),
  };
}
