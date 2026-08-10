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
 * ALPHABETICAL, NOT BY VALUE. This is a reference you consult while holding a shoe in a
 * thrift store, and the only order that helps then is the one your eye can scan.
 *
 * The whole page is built to be CORRECTED. Every brand can move tier and every model can
 * flip verdict, in one click, because the classification will be wrong sometimes and the
 * cost of a wrong row is a missed pickup or a wasted one.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, Check, Download, Gem, Lock, LockOpen, Plus, Search, Store, X } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SearchInput } from '../../components/ui';
import { useApi, useDebouncedValue } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { api } from '../../lib/api';
import type { BrandTier, EbayBrand, EbayBrandBook, ModelVerdict } from '../../lib/types';

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
      'The brand itself is the pickup signal. Grab these on sight — no model, material or edition needs to be true.',
    icon: Gem,
  },
  {
    tier: 'common',
    title: 'Common',
    blurb:
      'Not worth picking up on the label alone. Read the "Look for" line — only what it names is worth the money, and anything struck through is not.',
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

  for (const { tier, title, blurb } of GROUPS) {
    const brands = book.brands.filter((brand) => brand.tier === tier);
    if (!brands.length) continue;
    lines.push('', rule, `${title.toUpperCase()} (${brands.length})`, blurb, rule, '');

    for (const brand of brands) {
      lines.push(brand.name);
      // The "Look for" line is the whole point of a common row, so it leads — a printed
      // list of bare common brand names would be actively misleading in an aisle.
      if (brand.look_for) lines.push(`    Look for: ${brand.look_for}`);
      if (brand.notes) lines.push(`    ${brand.notes}`);
      // Only common brands turn on the model, so only they carry a model list.
      if (tier === 'common') {
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
  const [exporting, setExporting] = useState(false);
  const query = useDebouncedValue(search, 250);
  const book = useApi<EbayBrandBook>('/ebay/brands', { search: query });

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

  /* Exports the WHOLE book, not the current search. An export you have to remember to
     clear the filter for is one that quietly lies to you later. */
  async function exportBook() {
    setExporting(true);
    try {
      const all = await api.get<EbayBrandBook>('/ebay/brands');
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

  const total = book.data?.brands.length ?? 0;
  if (!total && !query) {
    return (
      <EmptyState
        icon={Gem}
        title="No brands yet"
        description="Scan a page of sold listings with the Lookout extension and send it here. Brands build up from what actually sold."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput value={search} onChange={setSearch} label="Search brands" placeholder="Search brands…" />
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
      </div>

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

// Deliberately brand-agnostic. The book holds hundreds of brands across categories, and
// a placeholder naming one brand's models suggests the field wants that kind of answer.
const LOOK_FOR_PLACEHOLDER =
  'Models, lines, materials, era, country of make, or collaborations worth buying';

function BrandRow({
  brand,
  onMove,
  onLock,
  onLookFor,
  onVerdict,
  onAddExclusion,
  onRemove,
}: {
  brand: EbayBrand;
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

      {/* Models matter for common brands; a rare brand is worth it whatever the model. */}
      {brand.tier === 'common' ? (
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
