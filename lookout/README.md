# Lookout

A Chrome extension that scans eBay **sold** listings for the brands worth sourcing, using
your Reseller Brand Guide, and sends what it finds to Wheelhouse.

Wheelhouse is the ship's bridge. The lookout is the one who spots things at a distance.

## What it is actually deciding

The point is not "find expensive shoes". It is the distinction the guide draws, which no
price filter can express:

| Tier | Meaning | Example |
|---|---|---|
| **master** | The label alone is the reason to inspect. | Alden, Grant Stone, Crockett & Jones |
| **exception** | Common brand; only specific models, lines, vintages or collabs count. | Nike **SB Dunk** yes, Nike Revolution no |
| **unlisted** | Not in the guide. | Faded Glory, U.S. Polo Assn. |

Unlisted is not the same as discarded. An unlisted brand that sells repeatedly at real
money is how the *next* revision of the guide gets written, so those are counted and
reported separately as candidates — evidence for you to read, never a buy list.

The per-brand numbers a scan produces (sold count, median, high) are **evidence, not the
verdict**. The guide already decided what is worth looking for; the scan tells you what it
currently fetches and how often it turns up.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Sign in to eBay in the same browser profile

## Use

**Lookout reads the eBay page you already have open. It never opens hidden tabs.**

**1 · Open sold listings** — four buttons: Men's shoes, Men's boots, Women's shoes,
Women's boots. Each loads that sold search *in this tab* and closes the popup, because
the next thing that should happen is you looking at the page: clearing any eBay check,
refining filters, deciding whether the results are what you wanted.

**2 · Read the page** — reopen Lookout, press it. Reads what is on screen and classifies
it against the guide.

**3 · Send to Wheelhouse** — imports the worthy listings.

That loop involves no automated navigation at all. For more than one page, click eBay's
own *Next* and read again, or tick **Turn pages for me** — which moves the tab you are
watching, at a jittered human pace, and stops the moment you press Stop.

| Setting | Default | Why |
|---|---|---|
| Sold over | $40 | Your floor. Applied by eBay via `_udlo`, then re-checked per listing. |
| Follow pages | 5 | Only used when *Turn pages for me* is ticked. 200 results each. |
| Pre-owned only | on | `LH_ItemCondition=3000`, re-checked against each card's own wording. |
| Turn pages for me | **off** | Off means zero automated navigation — you drive. |

**Pin from current tab** captures eBay's real `_sacat` category id off whatever eBay page
you have open and uses it for that category from then on. Until you do, the scan searches
by keyword — see *Category ids* below.

## How it is built

```
tools/build-catalog.mjs   Reseller Guide .docx  ->  catalog/*.json
catalog/                  the guide as data: master brands, exceptions + model tokens
lib/classify.js           the judgement: worthy / model-missing / unlisted
lib/ebay-url.js           every eBay query parameter, in one place
content/parser.js         the ONLY file that knows eBay's markup (shared with Wheelhouse)
content/collect.js        scrolls the page until it stops growing, then reads it
background.js             drives the scan, throttles it, sends results to Wheelhouse
popup/                    controls and results
```

### Re-importing the guide

The guide is the product knowledge and it gets revised — the men's edition is on v24. It
is a converter, not a transcription:

```bash
node tools/build-catalog.mjs ~/Downloads/Mens_Shoe_Reseller_AZ_Guide_v24.docx men-shoes
node tools/build-catalog.mjs ~/Downloads/Womens_Shoe_Reseller_AZ_Guide_v16_Fresh.docx women-shoes
```

It prints any exception whose rule yielded no matchable model or provenance signal. Those
can only ever come back as *model required* — worth a glance, because it usually means the
rule is written qualitatively ("premium leather models only") rather than naming anything.

### Tests

```bash
node tools/test-classify.mjs    # 29 cases: the worthy/common distinction itself
node tools/test-pipeline.mjs    # eBay-shaped DOM -> parser -> classifier -> rollup
```

`test-classify` is the one that matters. It asserts Faded Glory and U.S. Polo Assn never
pass, that Alden and Red Wing pass on the label alone, and that Nike passes **only** with a
listed model.

## eBay's policy — read this before deciding how to use it

eBay's `robots.txt` (v29_COM_July_2026) is explicit, and it is worth quoting rather than
paraphrasing:

> The use of robots or other automated means to access the eBay site without the express
> permission of eBay is strictly prohibited.

It also carries fourteen `Disallow: /sch` rules, including the exact path and parameters
a sold search uses:

```
Disallow: /sch/
Disallow: /sch/i.html?_nkw=
Disallow: /sch/*_sacat=
Disallow: /b/*LH_
```

So: **automated navigation of eBay search is against their stated policy**, and no amount
of throttling changes that. This is why the default mode does not navigate at all — it
reads a page you opened, which is ordinary use of a page you are entitled to view. That
is a meaningfully different act from crawling, and it is the mode to prefer.

If you tick *Turn pages for me*, you are automating navigation. That is your account and
your call; the defences below reduce the chance of tripping a limit, they do not make it
permitted.

### The defences, in order of how much they matter

1. **No hidden tabs.** Everything happens in the tab you are looking at.
2. **Jitter.** Every delay varies ±40%, page waits and scroll alike. A perfectly even
   4.000s interval is a stronger bot signal than the rate itself.
3. **Human-paced scrolling.** ~900px every ~420ms, smooth and irregular — not the
   1600px/220ms metronome the first version used.
4. **Sequential.** One tab, one page at a time. Never a parallel fetch.
5. **Cooldown.** A verification challenge stops the scan *and* blocks new ones for 30
   minutes. Retrying into a challenge is how a soft limit becomes a hard one.
6. **Daily budget.** 60 pages a day, hard. An unattended loop cannot quietly become a
   crawl.

It stores no credentials and never touches eBay's API.

### The sanctioned alternatives

If you want this data without the policy exposure, there are two real options, and both
are better long-term than any scraper:

- **Terapeak Product Research**, in Seller Hub — eBay's own sold-listing research tool,
  included with most Store subscriptions. It is *exactly* this data, offered deliberately.
  `content/parser.js` already has a Terapeak strategy, so pointing Lookout at a Terapeak
  page is a small change if you want to go that way.
- **Marketplace Insights API** — sold/completed data under the API License Agreement.
  Requires an application to eBay.

## Known gaps

**The brand rollup is posted and refused, by design.** *Send to Wheelhouse* posts two
payloads. The LISTINGS go to `/api/ebay/import` and that is the half that matters. The
per-brand ROLLUP goes to `POST /api/ebay/brands`, which no longer exists — it was removed
deliberately, not left unbuilt.

The reason is worth knowing before anyone rebuilds it: what arrived through that door was
not brands. Colour names came through, because the caller read every refinement list on
the page rather than the Brand one, and so did the leading words of unmatched titles —
"air", "nike air", "jordan retro". They also beat the classifier by twenty seconds and
filled the book before it answered. A door that lets an outside guesser write brands
cannot be made safe by validating harder at the threshold, because the caller cannot tell
a brand from a colour in the first place.

Wheelhouse now derives brands from the listings themselves. The rollup post fails
harmlessly and is reported rather than thrown, so a working import is never discarded.

**The eBay selectors are unverified against today's live eBay.** `content/parser.js` is
inherited from the Wheelhouse importer and carries three layout strategies with text-based
fallbacks, but no one has confirmed them against a current sold-results page. If a scan
returns 0 listings on a category you know is busy, that is the first thing to check —
open the page, and look at whether `li.s-card` still matches.

**Every Wheelhouse category is offered; the classifier prompt is still footwear-shaped.**
The dropdown is fetched from `GET /api/ebay/categories`, so all twenty-four appear —
it used to list two, hardcoded, and stayed that way while Wheelhouse grew around it.

What has not caught up is the wording Wheelhouse classifies with. Its prompt asks whether
a brand's *footwear* carries resale value, which is the right question for the four shoe
and boot categories and the wrong one for shirts or jeans. Reading clothing in will work,
but the tier it comes back with was decided by a question about shoes.

### Checking the selectors

On a real sold-results page, in the console:

```js
document.querySelectorAll('li.s-card, li.s-item, .su-card-container').length
```

Non-zero means the containers still match. If it is zero, update the `containers` array in
the relevant strategy in `content/parser.js` — that file is written to be the single place
that changes when eBay's markup does.
