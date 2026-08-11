/**
 * The brand-classification prompt — TEXT ONLY. Nothing here calls anything.
 *
 * Wheelhouse used to send this itself, to an OpenAI-compatible endpoint, and file whatever
 * came back. That path is gone: no API key, no network call, no background job. What is
 * left is the wording, kept because the question it asks is a good one and because the
 * answer shape it demands is exactly what `POST /api/ebay/brands/import` accepts.
 *
 * The workflow it belongs to now:
 *
 *   1. `npx tsx src/scripts/dump-prompt.ts men-shoes` prints this, followed by the
 *      category's numbered sold listings.
 *   2. You paste that wherever you like — a chat window, a model of your choosing, or
 *      nowhere at all if you would rather write the JSON by hand.
 *   3. You paste the JSON back into "Add brands" on the Brands tab.
 *
 * The app's part is step 3 and only step 3. It never decides what a brand is worth; it
 * files what you tell it.
 *
 * THE NUMBERING IS LOAD-BEARING. `items[].i` refers to the numbered lines the dump script
 * printed, and the import endpoint rebuilds that same list — priced above zero, ordered by
 * id, within one category — to turn a number back into a listing. Import more listings
 * between printing the prompt and pasting the answer and the numbers no longer line up, so
 * the `items` half is best pasted promptly. The `brands` half does not depend on it.
 */
export const SYSTEM = `Analyze these eBay SOLD listings and identify every brand represented.

Classify each brand using your existing knowledge of the brand and the resale market. Use the sold listings as supporting evidence, not as the sole basis for classification.

Classify every brand as:

### RARE

The brand itself has meaningful resale value.

If the brand's footwear normally sells for enough money that an experienced reseller should recognize the brand as a valuable brand to source, classify it as Rare.

The brand does NOT need to be literally rare or uncommon.

Not every model has to be valuable.

If the brand generally produces footwear with strong resale value, the brand belongs in Rare.

Examples:

Birkenstock → Rare
Ariat → Rare
HOKA → Rare
On Running → Rare
Danner → Rare
Salomon → Rare
RM Williams → Rare
Wesco → Rare
Gucci → Rare
Christian Louboutin → Rare

### COMMON

The brand as a whole does not have consistently strong enough resale value to qualify as Rare, but specific models, lines, collaborations, vintage versions, materials, or special variants are worth sourcing.

Examples:

Nike → Common. Nike has many valuable shoes, but value varies enormously by model. Specific models such as Kobe, desirable Air Max, Dunk, SB, collaborations, and limited releases are what the reseller needs to recognize.

New Balance → Common. Certain models and collaborations can be excellent, but ordinary New Balance footwear does not automatically have strong resale value.

Converse → Common. Specific vintage, premium, collaboration, and collectible models matter more than the brand alone.

For every Common brand, populate \`lookFor\` with exactly which models or versions are worth sourcing.

### NOT WORTHY

The brand does not generally have meaningful resale value and there are no important models or versions worth specifically learning to source.

### UNSORTED

Use only when you genuinely do not know enough about the brand to classify it.

### CORE RULE

Ask:

**"Is this a footwear brand that is generally valuable enough in the resale market that I should know and recognize the brand itself while sourcing?"**

YES → RARE

NO, but specific models or versions are valuable → COMMON

NO, and there are no meaningful models or versions to target → NOT WORTHY

I genuinely don't know enough about the brand → UNSORTED

Do not classify based on how famous, common, or physically rare a brand is.

"Rare" means **valuable resale brand**, not literally scarce.

Use your existing resale-market knowledge to make the classification.

Use the supplied sold listings to support the decision and identify models, not to define the entire brand.

### THE MODEL OF EACH ITEM

Separately from the brand classifications, identify what EACH numbered listing actually is.

Every listing gets one entry using its original number.

* \`brand\` — the brand that made it, spelled the same way as in the brand classifications.
* \`model\` — the specific model, line, or silhouette, such as "Air Max 90", "2002R", "1460", "Ghost Max", or "Bondi 8".

Strip size, colorway, condition, gender, and SKU from the model.

Return null if the listing title does not provide a readable model.

Do this for EVERY item in EVERY tier.

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
{
"i": 0,
"brand": "Brand Name",
"model": "Model Name"
}
]
}

For Common brands, always populate \`lookFor\`.

For Rare, Not Worthy, and Unsorted brands, \`lookFor\` should be null.

Keep reasoning short.

Every brand must appear exactly once.

Every numbered listing must appear exactly once.`;
