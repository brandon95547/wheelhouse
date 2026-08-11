/**
 * Read a pasted brand classification and turn it into something the book can be given.
 *
 * This replaces brand-ai.ts, and the difference is not the format — it is who is speaking.
 * The old file parsed a small model's answer, so most of it was defence: names with
 * question marks in them, listing titles returned where a brand belonged, "premium models"
 * offered as a description. Every one of those was dropped in silence, because there was
 * nobody to tell.
 *
 * A paste has an author, so nothing is dropped in silence. A row that cannot be filed comes
 * back as a line of `problems`, next to the row it came from, and the rest still lands. The
 * defensive heuristics are gone with the model that needed them: if you paste "Nike SB Dunk
 * Low" as a brand name, you meant it, and inventing a rule that quietly deletes it would be
 * the same failure the old code had, aimed at the wrong person.
 *
 * WHAT IT ACCEPTS. The shape brand-prompt.ts asks for, and the two obvious shorthands:
 *
 *   { "brands": [...], "items": [...] }    the full answer
 *   { "brands": [...] }                    brands only — the common case by hand
 *   [ ... ]                                a bare array, read as brands
 *
 * A brand row needs `name` and `tier` and nothing else. `lookFor` (or `look_for`) is
 * required in practice for `common` and ignored on `rare`; `models` is an optional list of
 * names to file under the brand, which is the easy way to record models without producing
 * the whole per-listing `items` half.
 *
 * An item row is `{ "i": 0, "brand": "...", "model": "..." }` and exists to attribute one
 * numbered listing. It is entirely optional — see the note on numbering in brand-prompt.ts,
 * and note that the import runs its own title matching afterwards regardless, so leaving
 * `items` out costs less than it used to.
 */
import { cleanLookFor, normaliseBrand, type Tier } from './brands.js';

export type PastedTier = Tier;

export interface PastedBrand {
  name: string;
  tier: PastedTier;
  /** Model names to file under the brand. May be empty. */
  models: string[];
  lookFor: string | null;
}

/** What one numbered listing is. `index` refers to the line number in the printed prompt. */
export interface PastedItem {
  index: number;
  brand: string;
  model: string | null;
}

export interface BrandReading {
  brands: PastedBrand[];
  items: PastedItem[];
}

export interface ParsedPaste extends BrandReading {
  /** Rows that could not be filed, in the words a person needs to fix them. */
  problems: string[];
}

/** Longer than this is a sentence, not a name. Generous on purpose. */
const MAX_NAME = 60;
const MAX_MODEL = 60;

/**
 * Tier spellings that mean the same thing.
 *
 * `master`/`exception` are the Lookout extension's vocabulary and are accepted so a catalog
 * written in those terms can be pasted without translating it first. Everything else is
 * just punctuation and case: "Not Worthy", "not-worthy" and "NOT_WORTHY" are one tier.
 */
function readTier(raw: unknown): PastedTier | null {
  const value = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (value === 'rare' || value === 'master') return 'rare';
  if (value === 'common' || value === 'exception') return 'common';
  if (value === 'not_worthy' || value === 'notworthy' || value === 'not_worth_it') return 'not_worthy';
  if (value === 'unsorted' || value === 'unknown' || value === '') return 'unsorted';
  return null;
}

const collapse = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Model names, kept as written apart from whitespace and length.
 *
 * The old cleaner stripped sizes, genders and parentheticals out of what a model claimed to
 * be, because the model it was reading returned "Air Max 90 Size 10" often enough to matter.
 * A person pasting "1460 (Made in England)" means the parenthetical, so it stays.
 */
function readModels(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of list) {
    const name = collapse(typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : entry);
    if (name.length < 2 || name.length > MAX_MODEL) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(name);
  }
  return models;
}

/** The brands half of whatever was pasted, whichever of the three shapes it arrived in. */
function brandRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const rows = (payload as { brands?: unknown }).brands;
    if (Array.isArray(rows)) return rows;
  }
  return null;
}

/**
 * Parse a paste. Throws only when there is no brands array at all — every other failure is
 * a `problems` line beside a reading that still holds everything usable.
 */
export function parseBrandPaste(payload: unknown): ParsedPaste {
  const rows = brandRows(payload);
  if (!rows) {
    throw new Error(
      'Expected a JSON object with a "brands" array — {"brands":[{"name":"…","tier":"rare"}]} — or a bare array of brands.',
    );
  }

  const problems: string[] = [];
  const brands: PastedBrand[] = [];
  const seen = new Map<string, string>();

  rows.forEach((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const where = `Row ${index + 1}`;

    const name = collapse(row.name ?? row.brand);
    if (!name) {
      problems.push(`${where}: no "name" — skipped.`);
      return;
    }
    if (name.length > MAX_NAME) {
      problems.push(`${where}: "${name.slice(0, 40)}…" is too long to be a brand name — skipped.`);
      return;
    }

    const tier = readTier(row.tier);
    if (tier === null) {
      problems.push(`${name}: "${collapse(row.tier)}" is not a tier — use rare, common, not_worthy or unsorted. Skipped.`);
      return;
    }

    /* Two rows for one brand is a paste that contradicts itself, and guessing which half
       was meant is exactly the kind of silent decision this file exists to avoid.
     *
     * Matched on the SLUG, not the spelling, because the book is: "Dr. Martens" and
     * "Dr Martens" are one row there, so two of them here would be one row arriving twice
     * with two different tiers. */
    const key = normaliseBrand(name);
    if (!key) {
      problems.push(`${where}: "${name}" has no letters or digits in it — skipped.`);
      return;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push(
        `${name}: already listed above as "${first}" — same brand, one row. Kept the first, ignored this one.`,
      );
      return;
    }

    const lookFor = cleanLookFor(row.lookFor ?? row.look_for ?? row.lookfor);

    /* THE ONE RULE THAT OVERRIDES WHAT WAS PASTED: a common brand that cannot say what to
       look for reads, in an aisle, as an endorsement of everything the brand makes. It is
       filed unsorted instead — but said out loud, because a downgrade nobody was told about
       would leave you believing the opposite of what the book now holds. */
    if (tier === 'common' && !lookFor) {
      problems.push(`${name}: common with no "lookFor" — filed as unsorted. Add what to look for and paste again.`);
    }

    seen.set(key, name);
    brands.push({ name, tier, models: readModels(row.models), lookFor });
  });

  const items: PastedItem[] = [];
  const itemRows = payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : null;
  let badItems = 0;

  for (const raw of Array.isArray(itemRows) ? itemRows : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const index = Number(row.i ?? row.index);
    const brand = collapse(row.brand);
    // A number that is not a line number points at no listing, and a nameless attribution
    // has nothing to attribute to. Counted rather than named — there can be hundreds.
    if (!Number.isInteger(index) || index < 0 || !brand || brand.length > MAX_NAME) {
      badItems += 1;
      continue;
    }
    const model = collapse(row.model);
    items.push({ index, brand, model: model && model.length <= MAX_MODEL ? model : null });
  }

  if (badItems) {
    problems.push(`${badItems} item row${badItems === 1 ? '' : 's'} had no usable line number or brand — ignored.`);
  }

  return { brands, items, problems };
}
