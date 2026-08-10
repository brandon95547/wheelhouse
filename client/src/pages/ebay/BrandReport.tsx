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
 * Nothing changes until "Apply" is pressed, and locked brands never change at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Gem, Lock, RefreshCw, Sparkles, Store, TrendingDown } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { useApi } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import type { BrandAnalysis, BrandProposal } from '../../lib/types';

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

interface ClassifyStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  listingCount: number;
  result: { applied: number; created: number; skipped: number; models: number } | null;
  error: string | null;
  aiConfigured: boolean;
}

/**
 * Reads the classification job while it runs.
 *
 * Polls only while something is happening. A job that takes a minute with no visible sign
 * of life is the failure this whole panel exists to prevent — an empty Brands tab looked
 * exactly like a broken one.
 */
function useClassifyStatus(onFinish: () => void) {
  const [status, setStatus] = useState<ClassifyStatus | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const next = await api.get<ClassifyStatus>('/ebay/brands/classify');
        if (cancelled) return;
        setStatus(next);
        if (wasRunning.current && !next.running) onFinish();
        wasRunning.current = next.running;
      } catch {
        /* The panel is a progress readout; a failed poll is not worth a toast. */
      }
    };

    read();
    const timer = setInterval(read, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onFinish]);

  return { status, setStatus };
}

export function BrandReport() {
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const analysis = useApi<BrandAnalysis>('/ebay/brands/analysis');

  const onFinish = useCallback(() => {
    analysis.reload();
    toast.success('Brand classification finished.');
  }, [analysis, toast]);

  const { status, setStatus } = useClassifyStatus(onFinish);

  async function classify() {
    try {
      const next = await api.post<ClassifyStatus & { message: string }>('/ebay/brands/classify');
      setStatus(next);
      toast.success(next.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start classification.');
    }
  }

  async function apply() {
    setApplying(true);
    try {
      const result = await api.post<{ applied: number; skipped: number; message: string }>(
        '/ebay/brands/rescore',
      );
      toast.success(result.message);
      analysis.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not apply the analysis.');
    } finally {
      setApplying(false);
    }
  }

  /* The classify panel renders BEFORE any early return. When the brand book is empty this
     panel is the only thing that can fill it, so hiding it behind "nothing to report yet"
     would hide the button that fixes exactly that. */
  const classifyPanel = (
    <section className="card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-on-surface">Classify brands from your listings</h2>
          <p className="mt-1 text-xs text-on-surface-muted">
            Reads every imported sold listing and sorts the brands into Rare, Common and Not
            worth it. Runs over everything you have imported, not just the last scan, so you
            can rebuild the book at any time without re-scanning eBay. Takes about a minute.
          </p>
          {status?.running ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-on-surface">
              <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
              Working through {status.listingCount} listing{status.listingCount === 1 ? '' : 's'}…
            </p>
          ) : status?.error ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-danger-text">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {status.error}
            </p>
          ) : status?.result ? (
            <p className="mt-2 text-xs text-on-surface-muted">
              Last run: {status.result.applied} brand{status.result.applied === 1 ? '' : 's'} filed
              ({status.result.created} new, {status.result.models} models
              {status.result.skipped ? `, ${status.result.skipped} left alone` : ''}).
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn-primary shrink-0 sm:ml-auto"
          onClick={classify}
          disabled={status?.running || status?.aiConfigured === false}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {status?.running ? 'Classifying…' : 'Classify brands'}
        </button>
      </div>
    </section>
  );

  if (analysis.loading && !analysis.data) {
    return (
      <div className="space-y-6">
        {classifyPanel}
        <LoadingState label="Scoring every brand…" />
      </div>
    );
  }
  if (analysis.error) return <ErrorState message={analysis.error} onRetry={analysis.reload} />;

  const proposals = analysis.data?.proposals ?? [];
  if (!proposals.length) {
    return (
      <div className="space-y-6">
        {classifyPanel}
        <EmptyState
          icon={Gem}
          title="No brands yet"
          description="Import sold listings, then press Classify brands to sort them into Rare, Common and Not worth it."
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
      {classifyPanel}

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
          <button
            type="button"
            className="btn btn-primary shrink-0 sm:ml-auto"
            onClick={apply}
            disabled={applying || counts.changed === 0}
          >
            <RefreshCw className={`size-4 ${applying ? 'animate-spin' : ''}`} aria-hidden="true" />
            {applying
              ? 'Applying…'
              : counts.changed === 0
                ? 'Nothing to change'
                : `Apply ${counts.changed} change${counts.changed === 1 ? '' : 's'}`}
          </button>
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
