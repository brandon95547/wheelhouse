/**
 * The brand book — what to look for, built from what has actually sold.
 *
 * Two groups, split by WHERE THE PICKUP SIGNAL LIVES:
 *
 *   Rare    the brand itself is the signal. Seeing the label is reason enough to pick
 *           the item up, so the row is just a name. You will not see many.
 *   Common  the specific model is the signal. The label is everywhere and worthless by
 *           default, so the row is USELESS WITHOUT ITS "Look for" LINE — that line is
 *           the actual content, and the brand name is only its heading.
 *
 * plus Unsorted, for brands an import turned up that no guide has judged. Those are not
 * noise — a brand selling repeatedly that nobody has classified is the most useful thing
 * a scan can surface — but they are kept apart so they never read as endorsed.
 *
 * That is why promoting a brand to Common opens a description field instead of moving it:
 * a Common row with nothing to look for tells someone standing in a thrift store that
 * every Nike on the rack is worth money, which is worse than telling them nothing.
 *
 * ONE BOOK PER CATEGORY. A brand is judged inside a category — Nike on a shoe rack is a
 * different question from Nike on a shirt rail — so the picker at the top is not a filter
 * over one book, it chooses WHICH book you are reading. "All categories" is the exception
 * and shows every one at once, which is why each row wears its category there.
 *
 * ALPHABETICAL, NOT BY VALUE. This is a reference you consult while holding a shoe in a
 * thrift store, and the only order that helps then is the one your eye can scan.
 *
 * The whole page is built to be CORRECTED. Every brand can move tier and every model can
 * flip verdict, in one click, because a classification will be wrong sometimes and the
 * cost of a wrong row is a missed pickup or a wasted one.
 *
 * WHERE THE ROWS COME FROM. Two places, both of them you. "Add brands" takes a pasted block
 * of JSON — name, tier, what to look for — and files the lot in one go; everything else on
 * the page edits one row at a time. Wheelhouse used to fill this book itself by sending
 * every scan to a language model, and does not any more: no key, no call, nothing deciding
 * what a brand is worth except the person reading it.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, Check, Download, Gem, Lock, LockOpen, Plus, Search, Store, Upload, X } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { EmptyState, ErrorState, LoadingState, SearchInput } from '../../components/ui';
import { useApi, useDebouncedValue } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { ApiError, api } from '../../lib/api';
import type {
  BrandPasteResult,
  BrandTier,
  EbayBrand,
  EbayBrandBook,
  EbayCategory,
  ModelVerdict,
} from '../../lib/types';

const GROUPS: Array<{
  tier: BrandTier;
  title: string;
  blurb: string;
  icon: typeof Gem;
}> = [
  {
    tier: 'rare',
    title: 'Rare',
    blurb:
      'The brand sells for real money on its own, so it is worth knowing on sight. "Rare" means valuable here, not scarce — plenty of these are common on the rack.',
    icon: Gem,
  },
  {
    tier: 'common',
    title: 'Common',
    blurb:
      'The label alone does not clear the bar, but specific models do. Read the "Look for" line — only what it names is worth the money, and anything struck through is not.',
    icon: Store,
  },
  {
    tier: 'unsorted',
    title: 'Unsorted',
    blurb:
      'Turned up in an import, not yet judged — or judged common with nothing specific to look for. Move each one to Rare or Common, or delete it.',
    icon: AlertTriangle,
  },
  {
    tier: 'not_worthy',
    title: 'Not worth it',
    blurb:
      'Judged against its own sales and found wanting: the brand does not sell, and no model within it does either. Kept rather than deleted so it is not re-examined from scratch every scan — and so you can see what was ruled out.',
    icon: Ban,
  },
];

/**
 * The book as plain text, for printing or reading on a phone in an aisle with no signal.
 * Grouped and labelled the same way the page is, so the paper and the screen never
 * disagree about what a brand is.
 */
function brandBookText(book: EbayBrandBook): string {
  const rule = '='.repeat(60);
  const lines = [
    'WHEELHOUSE BRAND BOOK',
    new Date().toLocaleString(),
    `${book.counts.rare} rare · ${book.counts.common} common · ${book.counts.unsorted} unsorted` +
      `${book.counts.not_worthy ? ` · ${book.counts.not_worthy} not worth it` : ''}`,
  ];

  /* One section per category, because a brand only means anything inside one. An export
     that ran the categories together would print "Nike — rare" and "Nike — common" as two
     unexplained contradictions. */
  const byCategory = new Map<string, EbayBrand[]>();
  for (const brand of book.brands) {
    const key = `${brand.category_group} / ${brand.category_name}`;
    byCategory.set(key, [...(byCategory.get(key) ?? []), brand]);
  }

  for (const [categoryLabel, categoryBrands] of byCategory) {
    lines.push('', '#'.repeat(60), categoryLabel.toUpperCase(), '#'.repeat(60));

    for (const { tier, title, blurb } of GROUPS) {
      const brands = categoryBrands.filter((brand) => brand.tier === tier);
      if (!brands.length) continue;
      lines.push('', rule, `${title.toUpperCase()} (${brands.length})`, blurb, rule, '');

      for (const brand of brands) {
        lines.push(brand.name);
        // The "Look for" line is the whole point of a common row, so it leads — a printed
        // list of bare common brand names would be actively misleading in an aisle.
        if (brand.look_for) lines.push(`    Look for: ${brand.look_for}`);
        if (brand.notes) lines.push(`    ${brand.notes}`);

        /* Models print under every tier now, not only common. On a rare brand they are not
           a buying rule — the label already decided that — they are what the brand has
           actually been seen selling, which is worth knowing while you hold one. */
        const worthy = brand.models.filter((m) => m.verdict === 'worthy');
        const skip = brand.models.filter((m) => m.verdict === 'not_worthy');
        if (worthy.length) lines.push(`    Seen selling: ${worthy.map((m) => m.name).join(', ')}`);
        if (skip.length) lines.push(`    Skip:         ${skip.map((m) => m.name).join(', ')}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export function BrandBook() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const query = useDebouncedValue(search, 250);
  const { data: categories } = useApi<EbayCategory[]>('/ebay/categories');
  const book = useApi<EbayBrandBook>('/ebay/brands', { search: query, category });

  /** Categories grouped for the <optgroup>s, same shape the listings filter uses. */
  const categoryGroups = useMemo(() => {
    const groups = new Map<string, EbayCategory[]>();
    for (const item of categories ?? []) {
      const list = groups.get(item.group_name) ?? [];
      list.push(item);
      groups.set(item.group_name, list);
    }
    return [...groups.entries()];
  }, [categories]);

  const grouped = useMemo(() => {
    const map = new Map<BrandTier, EbayBrand[]>([
      ['rare', []], ['common', []], ['unsorted', []], ['not_worthy', []],
    ]);
    for (const brand of book.data?.brands ?? []) map.get(brand.tier)?.push(brand);
    return map;
  }, [book.data]);

  /* `lookFor` travels WITH the tier in one request, so the server never sees a moment
     where the brand is common and undescribed — even a transient one. */
  async function moveTier(brand: EbayBrand, tier: BrandTier, lookFor?: string) {
    try {
      await api.patch(`/ebay/brands/${brand.id}`, {
        tier,
        ...(lookFor === undefined ? {} : { look_for: lookFor }),
      });
      toast.success(`${brand.name} moved to ${tier}.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move that brand.');
    }
  }

  /* The pin. Everything else on this page is a judgement that a later scan may revise;
     this is the one that says "stop revising it". */
  async function toggleLock(brand: EbayBrand) {
    const next = brand.locked ? 0 : 1;
    try {
      await api.patch(`/ebay/brands/${brand.id}`, { locked: next });
      toast.success(next ? `${brand.name} locked.` : `${brand.name} unlocked.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change the lock.');
    }
  }

  async function setLookFor(brand: EbayBrand, lookFor: string) {
    try {
      await api.patch(`/ebay/brands/${brand.id}`, { look_for: lookFor });
      toast.success(`Updated what to look for under ${brand.name}.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save that description.');
    }
  }

  async function setVerdict(brand: EbayBrand, modelId: number, verdict: ModelVerdict) {
    try {
      await api.patch(`/ebay/brands/${brand.id}/models/${modelId}`, { verdict });
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update that model.');
    }
  }

  async function addExclusion(brand: EbayBrand, name: string) {
    try {
      await api.post(`/ebay/brands/${brand.id}/models`, { name, verdict: 'not_worthy' });
      toast.success(`${name} marked not worth it under ${brand.name}.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add that model.');
    }
  }

  /* Ignores the search box, follows the category picker. The distinction is what each one
     means: a search is a transient filter, and an export you have to remember to clear it
     for quietly lies to you later — but the category is WHICH BOOK you are reading, and
     exporting a shoe book that silently included shirts would be the same lie in reverse. */
  async function exportBook() {
    setExporting(true);
    try {
      const all = await api.get<EbayBrandBook>('/ebay/brands', { category });
      const url = URL.createObjectURL(
        new Blob([brandBookText(all)], { type: 'text/plain;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `wheelhouse-brand-book-${new Date().toISOString().slice(0, 10)}.txt`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${all.brands.length} brand${all.brands.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not export the brand book.');
    } finally {
      setExporting(false);
    }
  }

  async function remove(brand: EbayBrand) {
    if (!window.confirm(`Remove ${brand.name} from the brand book?`)) return;
    try {
      await api.delete(`/ebay/brands/${brand.id}`);
      toast.success(`${brand.name} removed.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove that brand.');
    }
  }

  if (book.loading && !book.data) return <LoadingState label="Loading the brand book…" />;
  if (book.error) return <ErrorState message={book.error} onRetry={book.reload} />;

  /* Mounted only while open, so every visit starts empty rather than showing the last
     paste's text and result. It also lets the dialog read the category picker as it is at
     the moment you press the button. */
  const addDialog = adding ? (
    <AddBrandsDialog
      onClose={() => setAdding(false)}
      categories={categories ?? []}
      // The book you are already reading, unless you are reading all of them at once —
      // there is no such thing as adding a brand to "all categories".
      defaultCategory={category === 'all' ? '' : category}
      onDone={book.reload}
    />
  ) : null;

  const total = book.data?.brands.length ?? 0;
  if (!total && !query) {
    return (
      <>
        <EmptyState
          icon={Gem}
          title="No brands yet"
          description="Paste a block of classified brands to fill the book, or scan sold listings with the Lookout extension first so the brands you add arrive with prices behind them."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <Upload className="size-4" aria-hidden="true" />
              Add brands
            </button>
          }
        />
        {addDialog}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput value={search} onChange={setSearch} label="Search brands" placeholder="Search brands…" />
        <select
          className="select w-full sm:w-56"
          value={category}
          aria-label="Which category's brand book to read"
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="all">All categories</option>
          {categoryGroups.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-xs text-on-surface-muted sm:ml-auto" aria-live="polite">
          {book.data?.counts.rare ?? 0} rare · {book.data?.counts.common ?? 0} common ·{' '}
          {book.data?.counts.unsorted ?? 0} unsorted
          {book.data?.counts.not_worthy ? ` · ${book.data.counts.not_worthy} not worth it` : ''}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={exportBook}
          disabled={exporting}
        >
          <Download className="size-4" aria-hidden="true" />
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          <Upload className="size-4" aria-hidden="true" />
          Add brands
        </button>
      </div>

      {addDialog}

      {query && total === 0 ? (
        <EmptyState icon={Search} title="No matches" description="No brand in the book matches that search." />
      ) : null}

      {GROUPS.map(({ tier, title, blurb, icon: Icon }) => {
        const brands = grouped.get(tier) ?? [];
        if (!brands.length) return null;
        return (
          <section key={tier} className="card">
            <header className="border-b border-outline-variant p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                <Icon className="size-4 text-on-surface-muted" aria-hidden="true" />
                {title}
                <span className="text-xs font-normal text-on-surface-muted">({brands.length})</span>
              </h2>
              <p className="mt-1 text-xs text-on-surface-muted">{blurb}</p>
            </header>
            <ul className="divide-y divide-outline-variant">
              {brands.map((brand) => (
                <BrandRow
                  key={brand.id}
                  brand={brand}
                  // Only when every category is on screen at once. Inside one book the
                  // label would be the same on every row, which is noise.
                  showCategory={category === 'all'}
                  onMove={moveTier}
                  onLock={toggleLock}
                  onLookFor={setLookFor}
                  onVerdict={setVerdict}
                  onAddExclusion={addExclusion}
                  onRemove={remove}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/* An example rather than a schema, because the shape is easier to copy than to read. Two
   rows, one of each kind that behaves differently: a rare brand needs nothing but its name,
   and a common one is nothing without its "lookFor". */
const PASTE_EXAMPLE = `{
  "brands": [
    { "name": "Danner", "tier": "rare", "lookFor": null },
    {
      "name": "Nike",
      "tier": "common",
      "lookFor": "SB Dunk, Kobe, limited Air Max, collaborations",
      "models": ["SB Dunk Low", "Air Max 90"]
    }
  ]
}`;

/**
 * Add brands from pasted JSON.
 *
 * This is the whole of what used to be an API key, a background job and a minute of
 * waiting. The JSON is the same JSON — see server/src/lib/brand-prompt.ts for the prompt
 * that produces it, and `npx tsx src/scripts/dump-prompt.ts <category>` for a copy of it
 * with your listings attached — but the app is no longer the thing holding the conversation.
 *
 * The paste is parsed HERE before it is sent, so a stray comma is a red line under the box
 * rather than a round trip. Everything past "is this JSON" is the server's to judge, and it
 * answers with the rows it could not file rather than a total that hides them.
 */
function AddBrandsDialog({
  onClose,
  categories,
  defaultCategory,
  onDone,
}: {
  onClose: () => void;
  categories: EbayCategory[];
  defaultCategory: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [category, setCategory] = useState(defaultCategory);
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<BrandPasteResult | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, EbayCategory[]>();
    for (const item of categories) {
      map.set(item.group_name, [...(map.get(item.group_name) ?? []), item]);
    }
    return [...map.entries()];
  }, [categories]);

  /* Parsed on every keystroke rather than on submit. The paste is long and the mistake in
     it is usually one character, so saying which character while the box is still open is
     worth more than a tidy error afterwards. */
  const parsed = useMemo(() => {
    const body = text.trim();
    if (!body) return { value: null, error: null };
    try {
      return { value: JSON.parse(body) as unknown, error: null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : 'That is not valid JSON.' };
    }
  }, [text]);

  async function submit() {
    if (!category) {
      toast.error('Choose which category these brands belong to.');
      return;
    }
    if (parsed.value === null) return;

    setSaving(true);
    try {
      const response = await api.post<BrandPasteResult>('/ebay/brands/import', {
        category,
        overwrite,
        payload: parsed.value,
      });
      setResult(response);
      setText('');
      onDone();
      toast.success(response.message);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? (error.fieldErrors[0]?.message ?? error.message)
          : 'Could not add those brands.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Add brands"
      description="Paste classified brands as JSON. Wheelhouse files them; it does not judge them."
    >
      <div className="space-y-4 p-5">
        <div>
          <label className="label" htmlFor="paste-category">
            Category
          </label>
          <select
            id="paste-category"
            className="select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">— Choose a category —</option>
            {groups.map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="mt-1 text-xs text-on-surface-muted">
            A brand is judged inside one category — Nike on a shoe rack is a different
            question from Nike on a shirt rail — so these rows go into that book and no other.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="paste-json">
            Brands JSON
          </label>
          <textarea
            id="paste-json"
            className={`textarea min-h-56 font-mono text-xs ${parsed.error ? 'input-invalid' : ''}`}
            value={text}
            spellCheck={false}
            placeholder={PASTE_EXAMPLE}
            onChange={(event) => setText(event.target.value)}
            aria-invalid={Boolean(parsed.error)}
            aria-describedby="paste-json-help"
          />
          <p id="paste-json-help" className="mt-1 text-xs text-on-surface-muted">
            Each brand needs a <code>name</code> and a <code>tier</code> —{' '}
            <code>rare</code>, <code>common</code>, <code>not_worthy</code> or{' '}
            <code>unsorted</code>. A common brand also needs <code>lookFor</code> saying which
            models pay; without one it is filed unsorted, because a bare "Nike" in an aisle
            reads as an endorsement of every Nike on the rack. <code>models</code> is optional,
            and an <code>items</code> array from the full prompt is used if you include it.
          </p>
          {parsed.error ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-danger-text">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {parsed.error}
            </p>
          ) : null}
        </div>

        <label className="flex items-start gap-2 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          <span>
            Change brands already in this book
            <span className="block text-xs text-on-surface-muted">
              Off, a brand already here keeps the tier and description it has and only new
              brands are added. On, the paste moves them — except locked ones, which refuse
              it and are counted back to you.
            </span>
          </span>
        </label>

        {result ? (
          <div className="rounded border border-outline-variant bg-surface-container p-3">
            <p className="text-sm text-on-surface">{result.message}</p>
            <p className="mt-1 text-xs text-on-surface-muted">
              {result.attributed} listing{result.attributed === 1 ? '' : 's'} in{' '}
              {result.category.name} now match a brand in the book.
            </p>
            {result.problems.length ? (
              <ul className="mt-2 space-y-1">
                {result.problems.map((problem) => (
                  <li key={problem} className="flex items-start gap-1.5 text-xs text-danger-text">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {problem}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || !category || parsed.value === null}
          >
            <Upload className="size-4" aria-hidden="true" />
            {saving ? 'Adding…' : 'Add brands'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Deliberately brand-agnostic. The book holds hundreds of brands across categories, and
// a placeholder naming one brand's models suggests the field wants that kind of answer.
const LOOK_FOR_PLACEHOLDER =
  'Models, lines, materials, era, country of make, or collaborations worth buying';

function BrandRow({
  brand,
  showCategory,
  onMove,
  onLock,
  onLookFor,
  onVerdict,
  onAddExclusion,
  onRemove,
}: {
  brand: EbayBrand;
  showCategory: boolean;
  onMove: (brand: EbayBrand, tier: BrandTier, lookFor?: string) => void;
  onLock: (brand: EbayBrand) => void;
  onLookFor: (brand: EbayBrand, lookFor: string) => void;
  onVerdict: (brand: EbayBrand, modelId: number, verdict: ModelVerdict) => void;
  onAddExclusion: (brand: EbayBrand, name: string) => void;
  onRemove: (brand: EbayBrand) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  // Set while the row is asking what to look for. 'promote' also carries the tier move;
  // 'edit' only rewrites the description of a brand already common.
  const [asking, setAsking] = useState<'promote' | 'edit' | null>(null);
  const [lookForDraft, setLookForDraft] = useState('');

  // Exclusions first: they are the surprising information, and the reason to read a
  // common brand's row at all.
  const models = [...brand.models].sort((a, b) =>
    a.verdict === b.verdict ? b.sold_count - a.sold_count : a.verdict === 'not_worthy' ? -1 : 1,
  );

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-on-surface">{brand.name}</span>

        {showCategory ? (
          <span className="rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-muted">
            {brand.category_group} / {brand.category_name}
          </span>
        ) : null}

        {brand.locked ? (
          <span className="inline-flex items-center gap-1 rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-muted ring-1 ring-inset ring-outline">
            <Lock className="size-3" aria-hidden="true" />
            locked
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {/* Hidden rather than disabled while locked: a row of dead buttons invites the
              click that then does nothing, which reads as a bug rather than a pin. */}
          {(brand.locked ? [] : (['rare', 'common', 'unsorted', 'not_worthy'] as BrandTier[]))
            .filter((tier) => tier !== brand.tier)
            .map((tier) => (
              <button
                key={tier}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  // Becoming common means saying what to look for. If the brand already
                  // arrived with a description the move is still one click; if not, the
                  // row asks rather than filing an empty endorsement.
                  if (tier === 'common' && !brand.look_for) {
                    setLookForDraft('');
                    setAsking('promote');
                    return;
                  }
                  onMove(brand, tier);
                }}
              >
                → {tier === 'not_worthy' ? 'not worth it' : tier}
              </button>
            ))}
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${brand.locked ? 'text-on-surface' : ''}`}
            onClick={() => onLock(brand)}
            aria-pressed={Boolean(brand.locked)}
            aria-label={brand.locked ? `Unlock ${brand.name}` : `Lock ${brand.name}`}
            title={
              brand.locked
                ? 'Locked — re-scoring skips it and it cannot be deleted. Click to unlock.'
                : 'Lock this brand so re-scoring and deletion leave it alone'
            }
          >
            {brand.locked ? (
              <Lock className="size-3.5" aria-hidden="true" />
            ) : (
              <LockOpen className="size-3.5" aria-hidden="true" />
            )}
          </button>
          {!brand.locked ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-danger-text"
              onClick={() => onRemove(brand)}
              aria-label={`Remove ${brand.name}`}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {/* The "Look for" line. On a common brand this is the row's actual content — the
          brand name above it is only a heading — so it is rendered as body text, not as
          the muted afterthought that notes get. */}
      {asking ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = lookForDraft.trim();
            if (value.length < 3) return;
            if (asking === 'promote') onMove(brand, 'common', value);
            else onLookFor(brand, value);
            setAsking(null);
          }}
        >
          <label className="text-xs font-medium text-on-surface" htmlFor={`look-for-${brand.id}`}>
            Look for:
          </label>
          <input
            autoFocus
            id={`look-for-${brand.id}`}
            className="input h-8 min-w-0 flex-1 py-0 text-xs"
            value={lookForDraft}
            placeholder={LOOK_FOR_PLACEHOLDER}
            onChange={(event) => setLookForDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setAsking(null)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={lookForDraft.trim().length < 3}>
            {asking === 'promote' ? 'Make common' : 'Save'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </form>
      ) : brand.look_for ? (
        <p className="mt-1 text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Look for:</span> {brand.look_for}{' '}
          <button
            type="button"
            className="link text-xs"
            onClick={() => {
              setLookForDraft(brand.look_for ?? '');
              setAsking('edit');
            }}
          >
            edit
          </button>
        </p>
      ) : brand.tier === 'common' ? (
        // Should be unreachable — the API refuses to file an undescribed common brand —
        // but a row that lies by omission is exactly what this page exists to prevent,
        // so it says so out loud rather than rendering a bare, endorsing brand name.
        <p className="mt-1 flex items-center gap-1.5 text-sm text-danger-text">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          No description — this row does not say what to look for.
          <button
            type="button"
            className="link"
            onClick={() => {
              setLookForDraft('');
              setAsking('edit');
            }}
          >
            Add one
          </button>
        </p>
      ) : null}

      {brand.notes ? <p className="mt-1 text-xs text-on-surface-variant">{brand.notes}</p> : null}

      {/* Models on every tier, not only common.
        *
        * They read differently depending on the tier, and that is fine: under a common
        * brand a model is the buying rule, and under a rare one it is a record of what the
        * brand has been seen selling and for how much. Hiding them on rare brands used to
        * be justified as "the label already decided" — but the list is also what you need
        * in order to move a brand to common later, and a brand with nothing recorded cannot
        * tell you what to look for. Shown whenever there is something to show. */}
      {models.length || brand.tier === 'common' ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              title={
                model.verdict === 'worthy'
                  ? 'Worth the money — click to mark it not worth it'
                  : 'Not worth it — click to mark it worthy'
              }
              onClick={() =>
                onVerdict(brand, model.id, model.verdict === 'worthy' ? 'not_worthy' : 'worthy')
              }
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ring-1 ring-inset transition-colors ${
                model.verdict === 'worthy'
                  ? 'bg-success-container text-on-success-container ring-success/30'
                  : 'bg-surface-container text-on-surface-muted line-through ring-outline'
              }`}
            >
              {model.verdict === 'worthy' ? (
                <Check className="size-3" aria-hidden="true" />
              ) : (
                <X className="size-3" aria-hidden="true" />
              )}
              {model.name}
              {model.sold_count ? <span className="opacity-70">×{model.sold_count}</span> : null}
            </button>
          ))}

          {adding ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = draft.trim();
                if (!name) return;
                onAddExclusion(brand, name);
                setDraft('');
                setAdding(false);
              }}
            >
              <input
                autoFocus
                className="input h-7 w-44 py-0 text-xs"
                value={draft}
                placeholder="Model that is NOT worth it"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => !draft.trim() && setAdding(false)}
              />
              <button type="submit" className="btn btn-primary btn-sm">Add</button>
            </form>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              Not worth it
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}
