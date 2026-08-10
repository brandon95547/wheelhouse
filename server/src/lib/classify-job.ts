/**
 * Brand classification as a JOB, not as part of a request.
 *
 * WHY THIS EXISTS. Classification reads a whole scan and takes the better part of a
 * minute. Run inside `POST /import` it produced the worst possible behaviour: the
 * extension's fetch gave up, the user saw listings appear with no brands, and there was
 * no way to find out whether the work had failed or was still going. Worse, the import
 * only classified when it inserted NEW rows — so re-scanning the same eBay page deduped
 * every listing, skipped classification entirely, and left the user with no way to retry.
 *
 * So the job is separated from the import:
 *
 *   - it runs against the listings ALREADY STORED, which is the honest input — brands are
 *     judged on everything known about them, not on whichever slice arrived last;
 *   - it can be started by hand, so a book that came out wrong can simply be rebuilt;
 *   - the import kicks it off and does not wait, so an import stays fast;
 *   - one at a time, with a status anyone can read, so "nothing happened" is never again
 *     indistinguishable from "still working".
 *
 * In-memory status is deliberate. This is a single-user local app; a job that does not
 * survive a restart is fine, and a job table would be scaffolding for a problem nobody has.
 */
import { db } from './db.js';
import { classifyListings } from './brand-ai.js';
import { applyAiVerdicts } from './brand-analysis.js';
import { aiConfigured } from './llm.js';

export interface ClassifyStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Listings the running (or last) job was given. */
  listingCount: number;
  result: { applied: number; created: number; skipped: number; models: number } | null;
  error: string | null;
}

let status: ClassifyStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  listingCount: 0,
  result: null,
  error: null,
};

export const classifyStatus = (): ClassifyStatus => ({ ...status });

interface StoredListing {
  title: string;
  sold_price: number | null;
}

function storedListings(categoryId?: number): StoredListing[] {
  const sql =
    'SELECT title, sold_price FROM ebay_listings WHERE sold_price IS NOT NULL' +
    (categoryId ? ' AND category_id = ?' : '');
  return (categoryId ? db.prepare(sql).all(categoryId) : db.prepare(sql).all()) as StoredListing[];
}

/**
 * Run the classifier over stored listings and file the verdicts.
 *
 * Resolves when the work is done. Callers that must not wait — the import — should not
 * await it; see `startClassification`.
 */
export async function runClassification(categoryId?: number): Promise<ClassifyStatus> {
  const listings = storedListings(categoryId);

  status = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    listingCount: listings.length,
    result: null,
    error: null,
  };

  try {
    if (!aiConfigured()) throw new Error('OPENAI_API_KEY is not set');
    if (!listings.length) throw new Error('No listings with a sold price to classify');

    const verdicts = await classifyListings(listings);
    if (verdicts === null) {
      throw new Error('The classifier did not return a usable response — see the server log');
    }

    status.result = applyAiVerdicts(verdicts);
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
    console.warn(`[classify] ${status.error}`);
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }

  return classifyStatus();
}

/**
 * Start the job without waiting for it.
 *
 * Returns false when one is already running — two concurrent runs would race on the same
 * rows and bill twice for the same answer.
 */
export function startClassification(categoryId?: number): boolean {
  if (status.running) return false;
  // Marked immediately so a second call in the same tick cannot also start one.
  status = { ...status, running: true, error: null, result: null };
  void runClassification(categoryId);
  return true;
}
