import { useMemo, useState } from 'react';
import {
  Calculator,
  ExternalLink,
  ImageOff,
  PackageSearch,
  Puzzle,
  Scale,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageIntro } from '../components/PageIntro';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ResultCount,
  SearchInput,
  StatCard,
  TableScroll,
  Tabs,
  Toolbar,
} from '../components/ui';
import { BrandBook } from './ebay/BrandBook';
import { BrandReport } from './ebay/BrandReport';
import { useApi, useDebouncedValue } from '../hooks/useApi';
import { useToast } from '../hooks/useToast';
import { ApiError, api } from '../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
import type { EbayCategory, EbayListing, EbayStats } from '../lib/types';

const EMPTY_MESSAGE =
  'No eBay listings imported yet. Open an eBay sold-listings or Product Research page, then use the Wheelhouse browser extension to import the visible listings.';

/** Builds an eBay sold + completed listings search URL. */
function soldListingsUrl(query: string): string {
  const params = new URLSearchParams({
    _nkw: query,
    LH_Sold: '1',
    LH_Complete: '1',
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

function ListingImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className="grid size-14 place-items-center rounded border border-outline-variant bg-surface-container"
        role="img"
        aria-label="No image available"
      >
        <ImageOff className="size-4 text-on-surface-muted" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-14 rounded border border-outline-variant object-cover"
    />
  );
}

export function EbayResearchPage() {
  const toast = useToast();
  const [researchCategory, setResearchCategory] = useState('');
  const [researchQuery, setResearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [tab, setTab] = useState<'listings' | 'brands' | 'report'>('listings');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const search = useDebouncedValue(searchInput);

  const { data: categories } = useApi<EbayCategory[]>('/ebay/categories');
  const listings = useApi<EbayListing[]>('/ebay/listings', {
    search,
    category: categoryFilter,
  });
  const stats = useApi<EbayStats>('/ebay/stats', { search, category: categoryFilter });

  /** Categories grouped into Media / Men / Women for the <optgroup>s. */
  const grouped = useMemo(() => {
    const groups = new Map<string, EbayCategory[]>();
    for (const category of categories ?? []) {
      const list = groups.get(category.group_name) ?? [];
      list.push(category);
      groups.set(category.group_name, list);
    }
    return [...groups.entries()];
  }, [categories]);

  const selectedCategory = (categories ?? []).find((c) => c.slug === researchCategory);

  const openEbay = () => {
    const query = researchQuery.trim() || selectedCategory?.name || '';
    if (!query) {
      toast.error('Choose a category or type what you want to research first.');
      return;
    }
    window.open(soldListingsUrl(query), '_blank', 'noopener,noreferrer');
  };

  const clearListings = async () => {
    try {
      const result = await api.delete<{ deleted: number }>('/ebay/listings', {
        category: categoryFilter === 'all' ? undefined : categoryFilter,
      });
      setConfirmClear(false);
      listings.reload();
      stats.reload();
      toast.success(
        `Cleared ${result.deleted} listing${result.deleted === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not clear the listings.',
      );
    }
  };

  const deleteListing = async (listing: EbayListing) => {
    try {
      await api.delete(`/ebay/listings/${listing.id}`);
      listings.reload();
      stats.reload();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not delete that listing.',
      );
    }
  };

  const rows = listings.data ?? [];
  const hasFilters = search !== '' || categoryFilter !== 'all';
  const filterLabel =
    categoryFilter === 'all'
      ? 'all categories'
      : (categories ?? []).find((c) => c.slug === categoryFilter)?.name ?? categoryFilter;

  return (
    <>
      <PageIntro />

      {/* Two views of the same subject: what sold, and what that taught us about
          brands. Tabs rather than two pages because the brand book is only ever read
          in the context of the listings behind it. */}
      <Tabs
        label="eBay research views"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'listings', label: 'Sold Listings', count: listings.data?.length },
          { id: 'brands', label: 'Brands' },
          { id: 'report', label: 'Report' },
        ]}
      />

      {tab === 'report' ? <BrandReport /> : tab === 'brands' ? <BrandBook /> : <>

      {/* Research bar: pick a category, then open eBay in a new tab. */}
      <section className="card mb-6 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="research-category">
              Category
            </label>
            <select
              id="research-category"
              className="select"
              value={researchCategory}
              onChange={(event) => setResearchCategory(event.target.value)}
            >
              <option value="">— Choose a category —</option>
              {grouped.map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((category) => (
                    <option key={category.slug} value={category.slug}>
                      {category.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="research-query">
              Search eBay for
            </label>
            <input
              id="research-query"
              className="input"
              value={researchQuery}
              placeholder={selectedCategory ? selectedCategory.name : 'e.g. Carhartt jacket'}
              onChange={(event) => setResearchQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && openEbay()}
            />
          </div>

          <button type="button" className="btn btn-primary h-10" onClick={openEbay}>
            <ExternalLink className="size-4" aria-hidden="true" />
            Open eBay
          </button>
        </div>

        <p className="mt-3 flex items-start gap-2 text-xs text-on-surface-muted">
          <Puzzle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Opens eBay's sold and completed listings in a new tab using your normal browser
            session. When the results are on screen, click the Wheelhouse extension and
            import them. Wheelhouse never signs in to eBay or fetches pages on its own —{' '}
            <Link to="/settings" className="link">
              set up the extension in Settings
            </Link>
            .
          </span>
        </p>
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          icon={PackageSearch}
          label="Listings"
          value={stats.data?.total ?? 0}
          hint={filterLabel}
        />
        <StatCard icon={Calculator} label="Average" value={formatMoney(stats.data?.average)} hint="Sold price" />
        <StatCard icon={Scale} label="Median" value={formatMoney(stats.data?.median)} hint="Sold price" />
        <StatCard icon={TrendingDown} label="Lowest" value={formatMoney(stats.data?.lowest)} hint="Sold price" />
        <StatCard icon={TrendingUp} label="Highest" value={formatMoney(stats.data?.highest)} hint="Sold price" />
      </div>

      <div className="card mt-6">
        <Toolbar>
          <SearchInput
            label="Search imported listings"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search title or item ID…"
          />
          <select
            className="select w-full sm:w-52"
            value={categoryFilter}
            aria-label="Filter listings by category"
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="all">All categories</option>
            {grouped.map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setConfirmClear(true)}
            disabled={rows.length === 0}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Clear listings
          </button>
          <ResultCount count={rows.length} noun="listing" />
        </Toolbar>

        {listings.loading && rows.length === 0 ? (
          <LoadingState label="Loading imported listings…" />
        ) : listings.error ? (
          <ErrorState message={listings.error} onRetry={listings.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={hasFilters ? 'No listings match your filters' : 'No eBay listings imported yet'}
            description={hasFilters ? 'Try a different search term or category.' : EMPTY_MESSAGE}
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearchInput('');
                    setCategoryFilter('all');
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => document.getElementById('research-category')?.focus()}
                >
                  <PackageSearch className="size-4" aria-hidden="true" />
                  Choose a category to research
                </button>
              )
            }
          />
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Imported eBay sold listings</caption>
              <thead className="border-b border-outline-variant">
                <tr>
                  <th scope="col" className="th">Image</th>
                  <th scope="col" className="th">Title</th>
                  <th scope="col" className="th text-right">Sold</th>
                  <th scope="col" className="th text-right">Shipping</th>
                  <th scope="col" className="th text-right">Total</th>
                  <th scope="col" className="th">Sold date</th>
                  <th scope="col" className="th">Condition</th>
                  <th scope="col" className="th">Category</th>
                  <th scope="col" className="th">Imported</th>
                  <th scope="col" className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {rows.map((listing) => (
                  <tr key={listing.id} className="hover:bg-surface-container">
                    <td className="td">
                      <ListingImage src={listing.image_url} alt={listing.title} />
                    </td>
                    <td className="td">
                      <p className="max-w-sm text-on-surface">
                        {listing.title}
                      </p>
                      {listing.item_id ? (
                        <p className="mt-0.5 text-xs text-on-surface-muted">
                          Item {listing.item_id}
                        </p>
                      ) : null}
                    </td>
                    <td className="td text-right font-medium tabular-nums whitespace-nowrap">
                      {formatMoney(listing.sold_price)}
                    </td>
                    <td className="td text-right tabular-nums whitespace-nowrap">
                      {listing.shipping_price === null
                        ? '—'
                        : listing.shipping_price === 0
                          ? 'Free'
                          : formatMoney(listing.shipping_price)}
                    </td>
                    <td className="td text-right tabular-nums whitespace-nowrap">
                      {formatMoney(listing.total_price)}
                    </td>
                    <td className="td whitespace-nowrap">{formatDate(listing.sold_date)}</td>
                    <td className="td">{listing.condition ?? '—'}</td>
                    <td className="td whitespace-nowrap">
                      <span className="text-xs text-on-surface-muted">
                        {listing.category_group}
                      </span>
                      <br />
                      {listing.category_name}
                    </td>
                    <td className="td whitespace-nowrap text-xs">
                      {formatDateTime(listing.imported_at)}
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {listing.item_url ? (
                          <a
                            className="btn btn-ghost btn-icon"
                            href={listing.item_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            aria-label={`Open "${listing.title}" on eBay`}
                          >
                            <ExternalLink className="size-4" aria-hidden="true" />
                          </a>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon text-danger-text hover:bg-danger-container"
                          onClick={() => deleteListing(listing)}
                          aria-label={`Remove "${listing.title}" from Wheelhouse`}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
      </>}

      <ConfirmDialog
        open={confirmClear}
        title="Clear imported listings"
        message={
          categoryFilter === 'all'
            ? 'Remove every imported eBay listing from Wheelhouse? This cannot be undone.'
            : `Remove all imported listings in ${filterLabel}? This cannot be undone.`
        }
        confirmLabel="Clear listings"
        onConfirm={clearListings}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
