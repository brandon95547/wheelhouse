/**
 * The brand book — what to look for, built from what has actually sold.
 *
 * Two groups, in the language of the trade:
 *
 *   Rare    the label alone is reason to inspect. You will not see many.
 *   Common  the label is everywhere; only certain models carry value.
 *
 * plus Unsorted, for brands an import turned up that no guide has judged. Those are not
 * noise — a brand selling repeatedly that nobody has classified is the most useful thing
 * a scan can surface — but they are kept apart so they never read as endorsed.
 *
 * ALPHABETICAL, NOT BY VALUE. This is a reference you consult while holding a shoe in a
 * thrift store, and the only order that helps then is the one your eye can scan.
 *
 * The whole page is built to be CORRECTED. Every brand can move tier and every model can
 * flip verdict, in one click, because the classification will be wrong sometimes and the
 * cost of a wrong row is a missed pickup or a wasted one.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Gem, Plus, Search, Store, X } from 'lucide-react';
import { Badge, EmptyState, ErrorState, LoadingState, SearchInput } from '../../components/ui';
import { useApi, useDebouncedValue } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
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
    blurb: 'The label alone is reason to inspect. Pick these up on sight.',
    icon: Gem,
  },
  {
    tier: 'common',
    title: 'Common',
    blurb:
      'Everyone finds these. Only the models listed below are worth the money — anything struck through is not.',
    icon: Store,
  },
  {
    tier: 'unsorted',
    title: 'Unsorted',
    blurb:
      'Turned up in an import, not yet judged. Move each one to Rare or Common, or delete it.',
    icon: AlertTriangle,
  },
];

export function BrandBook() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search, 250);
  const book = useApi<EbayBrandBook>('/ebay/brands', { search: query });

  const grouped = useMemo(() => {
    const map = new Map<BrandTier, EbayBrand[]>([['rare', []], ['common', []], ['unsorted', []]]);
    for (const brand of book.data?.brands ?? []) map.get(brand.tier)?.push(brand);
    return map;
  }, [book.data]);

  async function moveTier(brand: EbayBrand, tier: BrandTier) {
    try {
      await api.patch(`/ebay/brands/${brand.id}`, { tier });
      toast.success(`${brand.name} moved to ${tier}.`);
      book.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move that brand.');
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
        </p>
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

function BrandRow({
  brand,
  onMove,
  onVerdict,
  onAddExclusion,
  onRemove,
}: {
  brand: EbayBrand;
  onMove: (brand: EbayBrand, tier: BrandTier) => void;
  onVerdict: (brand: EbayBrand, modelId: number, verdict: ModelVerdict) => void;
  onAddExclusion: (brand: EbayBrand, name: string) => void;
  onRemove: (brand: EbayBrand) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  // Exclusions first: they are the surprising information, and the reason to read a
  // common brand's row at all.
  const models = [...brand.models].sort((a, b) =>
    a.verdict === b.verdict ? b.sold_count - a.sold_count : a.verdict === 'not_worthy' ? -1 : 1,
  );

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold text-on-surface">{brand.name}</span>
        {brand.median_price !== null ? (
          <span className="text-sm font-semibold text-success-text tabular-nums">
            {formatMoney(brand.median_price)}
          </span>
        ) : null}
        <span className="text-xs text-on-surface-muted">
          {brand.sold_count} sold
          {brand.rejected_count ? ` · ${brand.rejected_count} wrong model` : ''}
          {brand.high_price ? ` · high ${formatMoney(brand.high_price)}` : ''}
        </span>
        {brand.tier_source === 'manual' ? <Badge tone="neutral">edited</Badge> : null}

        <div className="ml-auto flex items-center gap-1">
          {(['rare', 'common', 'unsorted'] as BrandTier[])
            .filter((tier) => tier !== brand.tier)
            .map((tier) => (
              <button
                key={tier}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onMove(brand, tier)}
              >
                → {tier}
              </button>
            ))}
          <button
            type="button"
            className="btn btn-ghost btn-sm text-danger-text"
            onClick={() => onRemove(brand)}
            aria-label={`Remove ${brand.name}`}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

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
