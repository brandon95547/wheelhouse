/**
 * The report — what every sold listing in the system says about every brand in the book.
 *
 * The brand book answers "what do I do with this shoe". This answers the question behind
 * it: WHY does the book say that, and does the evidence still support it. With a few
 * thousand listings accumulated, those are different questions — a brand judged on twenty
 * sales last month may look completely different on four hundred.
 *
 * Everything here is a rank statistic. The mean is never shown, because the mean is what
 * makes a worthless brand with two lucky sales look like a good one, and this page exists
 * to prevent exactly that mistake.
 *
 * NOTHING ON THIS PAGE MOVES A TIER ANY MORE. The arithmetic still runs and still says
 * what it thinks, because "why is this rare" deserves an answer with numbers in it — but
 * a brand already in the book keeps the tier it has until the user changes it in the Brand
 * Book. What was once an "Apply" button is now a comparison: here is what the sold prices
 * would say, next to what the book says, and the difference is yours to act on or ignore.
 *
 * The "Classify brands" panel that used to sit at the top is gone with the model behind it.
 * What it did — read the listings, invent the brands, write them down — is now "Add brands"
 * on the Brand Book tab, where you paste the classification instead of buying one. What is
 * left here is "Re-match listings", which is the half of that job that was ever arithmetic:
 * pointing each sale at a brand already in the book so the figures below are current.
 */
import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, Gem, Lock, RefreshCw, Store, TrendingDown } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import type { BrandAnalysis, BrandProposal, EbayCategory } from '../../lib/types';

const STRENGTH: Record<
  BrandProposal['stats']['strength'],
  { label: string; blurb: string; icon: typeof Gem; tone: string }
> = {
  rare: {
    label: 'Worth it on the label',
    blurb: 'A random example clears the bar. The brand itself is the pickup signal.',
    icon: Gem,
    tone: 'text-success-text',
  },
  common: {
    label: 'Worth it on the model',
    blurb: 'Most sell cheap, but a real tail pays. Only the models named below.',
    icon: Store,
    tone: 'text-on-surface',
  },
  weak: {
    label: 'Not worth picking up',
    blurb: 'The sales do not support keeping this in the book as a buy signal.',
    icon: TrendingDown,
    tone: 'text-danger-text',
  },
  thin: {
    label: 'Not enough sales yet',
    blurb: 'Held back deliberately — a tier from a handful of sales describes the sample, not the brand.',
    icon: AlertTriangle,
    tone: 'text-on-surface-muted',
  },
};

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export function BrandReport() {
  const toast = useToast();
  /* Empty means every category, which is the right default for a page you read rather than
     act on. Attribution below never crosses a category line either way, so "all" is a
     wider view of the same arithmetic, not a looser one. */
  const [category, setCategory] = useState('');
  const [matching, setMatching] = useState(false);
  const { data: categories } = useApi<EbayCategory[]>('/ebay/categories');
  const analysis = useApi<BrandAnalysis>('/ebay/brands/analysis', { category: category || 'all' });

  const categoryGroups = useMemo(() => {
    const groups = new Map<string, EbayCategory[]>();
    for (const item of categories ?? []) {
      const list = groups.get(item.group_name) ?? [];
      list.push(item);
      groups.set(item.group_name, list);
    }
    return [...groups.entries()];
  }, [categories]);

  const rematch = useCallback(async () => {
    setMatching(true);
    try {
      const result = await api.post<{ message: string }>('/ebay/brands/rescore', {
        category: category || 'all',
      });
      analysis.reload();
      toast.success(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not re-match the listings.');
    } finally {
      setMatching(false);
    }
  }, [analysis, category, toast]);

  /* This panel renders BEFORE any early return. When there is nothing to report it is the
     only control on the page, and hiding it behind "no brands yet" would hide the button
     that makes a freshly pasted book count its sales. */
  const matchPanel = (
    <section className="card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-on-surface">Match listings to the book</h2>
          <p className="mt-1 text-xs text-on-surface-muted">
            Points every imported sale at the brand in its title, and at the model within
            that brand, so the figures below come from the sales that actually carried them.
            Run it after adding brands by hand — a brand added today does not know about the
            listings imported last month until this has seen them. It moves nothing between
            tiers.
          </p>
          <label className="sr-only" htmlFor="report-category">
            Category to report on
          </label>
          <select
            id="report-category"
            className="select mt-2 w-full sm:w-64"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All categories</option>
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
        </div>
        <button
          type="button"
          className="btn btn-secondary shrink-0 sm:ml-auto"
          onClick={rematch}
          disabled={matching}
        >
          <RefreshCw className={`size-4 ${matching ? 'animate-spin' : ''}`} aria-hidden="true" />
          {matching ? 'Matching…' : 'Re-match listings'}
        </button>
      </div>
    </section>
  );

  if (analysis.loading && !analysis.data) {
    return (
      <div className="space-y-6">
        {matchPanel}
        <LoadingState label="Scoring every brand…" />
      </div>
    );
  }
  if (analysis.error) return <ErrorState message={analysis.error} onRetry={analysis.reload} />;

  const proposals = analysis.data?.proposals ?? [];
  if (!proposals.length) {
    return (
      <div className="space-y-6">
        {matchPanel}
        <EmptyState
          icon={Gem}
          title="No brands yet"
          description="Nothing to score until the book has something in it. Add brands on the Brands tab — paste them as JSON — and their sold prices will be waiting here."
        />
      </div>
    );
  }

  const gates = analysis.data!.gates;
  const counts = analysis.data!.counts;

  // Changes first: they are the only rows that need a decision. Within them, the ones
  // with the most sales behind them lead, because those are the ones to trust.
  const ordered = [...proposals].sort(
    (a, b) =>
      Number(b.changed && !b.locked) - Number(a.changed && !a.locked) ||
      b.stats.sampleSize - a.stats.sampleSize,
  );

  return (
    <div className="space-y-6">
      {matchPanel}

      <section className="card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-on-surface">What the sales say</h2>
            <p className="mt-1 text-xs text-on-surface-muted">
              A brand is <strong className="text-on-surface">worth it on the label</strong> when its
              median clears {formatMoney(gates.rare.medianAtLeast)}, its lower quartile clears{' '}
              {formatMoney(gates.rare.lowerQuartileAtLeast)}, and at least{' '}
              {pct(gates.rare.shareAtLeast.fraction)} of its sales clear{' '}
              {formatMoney(gates.rare.shareAtLeast.price)} — measured on the median and the lower
              end, never the average, so a couple of lucky sales cannot carry a weak brand. Brands
              with fewer than {gates.minSample} sales are left alone.
            </p>
          </div>
          {/* No Apply button. This page reports; it does not act. A brand's tier is set
              once, when the brand is first seen, and changed only by you in the Brand Book
              — so the useful thing to show here is where the numbers disagree with what the
              book says, and let you go and decide. */}
          <p className="shrink-0 text-xs text-on-surface-muted sm:ml-auto sm:max-w-56 sm:text-right">
            {counts.changed === 0
              ? 'The sold prices agree with every tier in the book.'
              : `The sold prices would tier ${counts.changed} brand${counts.changed === 1 ? '' : 's'} differently. Move any you agree with in the Brand Book.`}
          </p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ['Worth it on the label', counts.rare],
            ['Worth it on the model', counts.common],
            ['Unsorted', counts.unsorted],
            ['Would change', counts.changed],
            ['Locked', counts.locked],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded border border-outline-variant p-2">
              <dt className="text-xs text-on-surface-muted">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-on-surface">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ul className="space-y-3">
        {ordered.map((proposal) => (
          <ProposalRow key={proposal.brandId} proposal={proposal} />
        ))}
      </ul>
    </div>
  );
}

function ProposalRow({ proposal }: { proposal: BrandProposal }) {
  const { stats } = proposal;
  const strength = STRENGTH[stats.strength];
  const Icon = strength.icon;
  const willChange = proposal.changed && !proposal.locked;

  return (
    <li className={`card p-4 ${willChange ? 'ring-1 ring-inset ring-primary/40' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Icon className={`size-4 shrink-0 self-center ${strength.tone}`} aria-hidden="true" />
        <span className="font-semibold text-on-surface">{proposal.name}</span>
        <span className={`text-xs ${strength.tone}`}>{strength.label}</span>

        {proposal.locked ? (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Lock className="size-3" aria-hidden="true" />
            locked — left alone
          </span>
        ) : willChange ? (
          <span className="text-xs text-on-surface">
            {proposal.currentTier} <span aria-label="becomes">→</span>{' '}
            <strong>{proposal.proposedTier}</strong>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Check className="size-3" aria-hidden="true" />
            already {proposal.currentTier}
          </span>
        )}

        <span className="ml-auto text-xs tabular-nums text-on-surface-muted">
          {stats.sampleSize} sale{stats.sampleSize === 1 ? '' : 's'}
          {stats.sampleSize > 0 && !stats.confident ? ' · thin evidence' : ''}
        </span>
      </div>

      <p className="mt-1 text-sm text-on-surface-variant">{stats.reason}</p>

      {stats.sampleSize > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-on-surface-muted">
          <span>
            median <strong className="text-on-surface">{formatMoney(stats.median)}</strong>
          </span>
          <span>
            lower quartile <strong className="text-on-surface">{formatMoney(stats.lowerQuartile)}</strong>
          </span>
          <span>
            top 10% <strong className="text-on-surface">{formatMoney(stats.topDecile)}</strong>
          </span>
          <span aria-hidden="true">·</span>
          {(['40', '50', '60', '100'] as const).map((price) => (
            <span key={price}>
              ≥${price}: <strong className="text-on-surface">{pct(stats.shareAt[price])}</strong>
            </span>
          ))}
        </div>
      ) : null}

      {proposal.models.length ? (
        <div className="mt-2">
          <p className="text-xs text-on-surface-muted">
            Models carrying the price — how much likelier each is to appear in a sale that paid:
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {proposal.models.map((model) => (
              <span
                key={model.name}
                className="inline-flex items-center gap-1 rounded bg-success-container px-2 py-0.5 text-xs text-on-success-container"
                title={`${model.hits} sales · ${model.lift}× more likely above the line · median ${formatMoney(model.medianPrice)}`}
              >
                {model.name}
                <span className="opacity-70">×{model.hits}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}
