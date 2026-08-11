/*
 * ============================================================================
 * Lookout — page collector
 * ============================================================================
 *
 * Runs inside an eBay search-results tab, after content/parser.js has defined
 * WheelhouseParser. Its whole job is: make sure the results are actually in the DOM,
 * then hand them back. It makes no judgements — classification happens in the service
 * worker, against the guide.
 *
 * WHY IT SCROLLS. eBay lazy-loads below the fold. At 200 results per page the tail of
 * the list is not rendered until it approaches the viewport, so reading the DOM on load
 * returns the first screenful and silently misses the rest — which looks exactly like a
 * thin category. The scroll is not decoration; it is what makes the page count honest.
 *
 * It also reports two things the scan needs in order to stop rather than grind on:
 * whether the session is signed in, and whether eBay has served an interstitial instead
 * of results.
 */

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ signals */

  /** Signed in? eBay greets you by name and drops the "Sign in" link when you are. */
  function detectSignedIn() {
    const header = document.querySelector('#gh, #gh-top, header')?.textContent ?? '';
    if (/\bHi\s+\w/i.test(header)) return true;
    const signInLink = document.querySelector('a[href*="signin.ebay."], #gh-ug, #gh-sign-in');
    if (signInLink && /sign in/i.test(signInLink.textContent ?? '')) return false;
    return /\bHi\s+\w/i.test(document.body.textContent?.slice(0, 4000) ?? '') ? true : null;
  }

  /** Has eBay served a challenge instead of results? A scan must stop, not retry. */
  function detectBlocked() {
    const text = document.body?.textContent ?? '';
    if (/\bunusual traffic\b|\bverify (?:you are|yourself)\b|\bpardon our interruption\b/i.test(text)) {
      return 'challenge';
    }
    if (/captcha/i.test(document.title ?? '')) return 'captcha';
    if (/\/splashui\/captcha/i.test(location.pathname)) return 'captcha';
    return null;
  }

  /** eBay's own Brand facet, when the sidebar offers one.
   *
   *  Authoritative spelling straight from eBay's aspect data — worth having because it
   *  names brands exactly as eBay indexes them, which is a better seed for the guide
   *  than anything inferred from a title. Absent on many result pages, so it is a bonus
   *  rather than a dependency. */
  function readBrandFacet() {
    const out = [];
    const groups = document.querySelectorAll('.x-refine__main__list, .srp-refine__category__list, [class*="refine"] ul');
    for (const group of groups) {
      const heading = group.previousElementSibling?.textContent ?? group.getAttribute('aria-label') ?? '';
      if (!/brand/i.test(heading)) continue;
      for (const item of group.querySelectorAll('li')) {
        const label = (item.querySelector('.cbx, span, a')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const m = label.match(/^(.*?)\s*\((\d[\d,]*)\)\s*$/);
        if (m) out.push({ name: m[1].trim(), count: Number(m[2].replace(/,/g, '')) });
        else if (label.length < 60) out.push({ name: label, count: null });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ scrolling */

  /* Scrolling is the loudest bot signal on the page. A fixed 1600px every 220ms is
     nothing a hand produces — it is perfectly periodic, far faster than reading, and
     identical on every page. Real scrolling is irregular in both distance and pause, so
     both are jittered and the pace is roughly halved. It costs a few seconds per page
     and it is the single cheapest thing that makes this look like use rather than
     collection. */
  const jitter = (base, spread = 0.4) =>
    Math.round(base * (1 - spread + Math.random() * spread * 2));

  /**
   * Scroll the page in steps until the result count stops growing.
   *
   * Bounded by both a pass limit and a stable-count check: eBay occasionally keeps a
   * page growing as long as you keep scrolling, and an unbounded loop here would hang
   * the whole scan on one page.
   */
  async function scrollUntilSettled({ maxPasses = 40, stepPx = 900, waitMs = 420 } = {}) {
    const countCards = () =>
      document.querySelectorAll('li.s-card, li.s-item, .su-card-container').length;

    let previous = countCards();
    let stable = 0;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      window.scrollBy({ top: jitter(stepPx), behavior: 'smooth' });
      await sleep(jitter(waitMs));
      const current = countCards();

      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;

      if (current === previous) {
        stable += 1;
        // Two settled passes at the bottom means the list is fully rendered.
        if (stable >= 2 && atBottom) break;
      } else {
        stable = 0;
      }
      previous = current;
    }

    window.scrollTo(0, 0);
    return countCards();
  }

  /* -------------------------------------------------------------------- collect */

  async function collect() {
    const blocked = detectBlocked();
    if (blocked) {
      return { ok: false, blocked, signedIn: detectSignedIn(), listings: [], url: location.href };
    }

    const cardsAfterScroll = await scrollUntilSettled();
    const parsed = globalThis.WheelhouseParser?.extractAll?.();

    if (!parsed) {
      return { ok: false, blocked: null, error: 'parser did not load', listings: [], url: location.href };
    }

    // "Next" exists means there is another page worth asking for. Cheaper and more
    // reliable than guessing from a result count eBay rounds.
    const hasNext = Boolean(
      document.querySelector('a.pagination__next:not([aria-disabled="true"]), a[type="next"]:not([aria-disabled="true"])'),
    );

    return {
      ok: true,
      blocked: null,
      signedIn: detectSignedIn(),
      url: location.href,
      strategy: parsed.strategy,
      cardsAfterScroll,
      found: parsed.found,
      listings: parsed.listings,
      brandFacet: readBrandFacet(),
      hasNext,
      diagnostics: parsed.diagnostics,
    };
  }

  // The service worker awaits this promise as the injection result.
  return collect();
})();
