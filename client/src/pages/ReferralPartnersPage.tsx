import { useState } from 'react';
import { Handshake, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { PageIntro } from '../components/PageIntro';
import { RecordForm } from '../components/RecordForm';
import type { FieldDef } from '../components/RecordForm';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ResultCount,
  SearchInput,
  TableScroll,
  Toolbar,
} from '../components/ui';
import { useDebouncedValue } from '../hooks/useApi';
import { useCrudPage } from '../hooks/useCrudPage';
import { useToast } from '../hooks/useToast';
import { ApiError, api } from '../lib/api';
import { displayUrl, externalHref } from '../lib/format';
import type { ReferralPartner } from '../lib/types';

const fields: FieldDef[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'company', label: 'Company' },
  { name: 'industry', label: 'Industry', placeholder: 'Accounting, web design…' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone', type: 'tel' },
  { name: 'website', label: 'Website', type: 'url', placeholder: 'https://' },
  { name: 'referrals_sent', label: 'Referrals sent', type: 'number', min: 0 },
  { name: 'referrals_received', label: 'Referrals received', type: 'number', min: 0 },
  { name: 'notes', label: 'Notes', type: 'textarea', rows: 5 },
];

/** Counter with a +1 button, so logging a referral is a single click. */
function ReferralCounter({
  value,
  label,
  onIncrement,
}: {
  value: number;
  label: string;
  onIncrement: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums">{value}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onIncrement}
        aria-label={label}
      >
        +1
      </button>
    </span>
  );
}

export function ReferralPartnersPage() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput);
  const toast = useToast();

  const crud = useCrudPage<ReferralPartner>('/referral-partners', 'Partner', { search });

  const bump = async (
    partner: ReferralPartner,
    field: 'referrals_sent' | 'referrals_received',
  ) => {
    try {
      await api.patch(`/referral-partners/${partner.id}`, {
        [field]: partner[field] + 1,
      });
      crud.reload();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not update the referral count.',
      );
    }
  };

  return (
    <>
      <PageIntro
        actions={
          <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            Add partner
          </button>
        }
      />

      <div className="card">
        <Toolbar>
          <SearchInput
            label="Search referral partners"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search name, company, industry…"
          />
          <ResultCount count={crud.rows.length} noun="partner" />
        </Toolbar>

        {crud.loading && crud.rows.length === 0 ? (
          <LoadingState label="Loading referral partners…" />
        ) : crud.error ? (
          <ErrorState message={crud.error} onRetry={crud.reload} />
        ) : crud.rows.length === 0 ? (
          <EmptyState
            icon={Handshake}
            title={search ? 'No partners match your search' : 'No referral partners yet'}
            description={
              search
                ? 'Try a different search term.'
                : 'Add the people and businesses you swap referrals with, and keep a running count of what you have sent and received.'
            }
            action={
              search ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSearchInput('')}
                >
                  Clear search
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add partner
                </button>
              )
            }
          />
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Referral partners</caption>
              <thead className="border-b border-outline-variant">
                <tr>
                  <th scope="col" className="th">Partner</th>
                  <th scope="col" className="th">Industry</th>
                  <th scope="col" className="th">Contact</th>
                  <th scope="col" className="th">Sent</th>
                  <th scope="col" className="th">Received</th>
                  <th scope="col" className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {crud.rows.map((partner) => (
                  <tr key={partner.id} className="hover:bg-surface-container">
                    <td className="td">
                      <p className="font-medium text-on-surface">
                        {partner.name}
                      </p>
                      {partner.company ? (
                        <p className="text-xs text-on-surface-muted">
                          {partner.company}
                        </p>
                      ) : null}
                      {partner.notes ? (
                        <p className="mt-1 line-clamp-2 max-w-xs text-xs text-on-surface-muted">
                          {partner.notes}
                        </p>
                      ) : null}
                    </td>
                    <td className="td">{partner.industry ?? '—'}</td>
                    <td className="td">
                      <div className="space-y-0.5 text-xs">
                        {partner.email ? (
                          <a className="link block" href={`mailto:${partner.email}`}>
                            {partner.email}
                          </a>
                        ) : null}
                        {partner.phone ? (
                          <a className="link block" href={`tel:${partner.phone}`}>
                            {partner.phone}
                          </a>
                        ) : null}
                        {partner.website ? (
                          <a
                            className="link block"
                            href={externalHref(partner.website)}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {displayUrl(partner.website)}
                          </a>
                        ) : null}
                        {!partner.email && !partner.phone && !partner.website ? (
                          <span className="text-on-surface-muted">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="td">
                      <ReferralCounter
                        value={partner.referrals_sent}
                        label={`Add a referral sent to ${partner.name}`}
                        onIncrement={() => bump(partner, 'referrals_sent')}
                      />
                    </td>
                    <td className="td">
                      <ReferralCounter
                        value={partner.referrals_received}
                        label={`Add a referral received from ${partner.name}`}
                        onIncrement={() => bump(partner, 'referrals_received')}
                      />
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={() => crud.openEdit(partner)}
                          aria-label={`Edit ${partner.name}`}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon text-danger-text hover:bg-danger-container"
                          onClick={() => crud.requestDelete(partner)}
                          aria-label={`Delete ${partner.name}`}
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

      <Modal
        open={crud.formOpen}
        onClose={crud.closeForm}
        title={crud.editing ? 'Edit referral partner' : 'Add referral partner'}
        description={
          crud.editing
            ? 'Update this partner.'
            : 'Add someone you exchange referrals with. Only the name is required.'
        }
      >
        <RecordForm
          key={crud.editing?.id ?? 'new'}
          fields={fields}
          record={crud.editing as unknown as Record<string, unknown> | null}
          submitLabel={crud.editing ? 'Save changes' : 'Add partner'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete referral partner"
        message={`Delete ${crud.deleting?.name ?? 'this partner'}? This cannot be undone.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
