import { useState } from 'react';
import { ArrowRightLeft, Loader2, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { PageIntro } from '../components/PageIntro';
import { RecordForm } from '../components/RecordForm';
import type { FieldDef } from '../components/RecordForm';
import {
  Badge,
  EmptyState,
  ErrorState,
  FilterSelect,
  LoadingState,
  ResultCount,
  SearchInput,
  TableScroll,
  Toolbar,
} from '../components/ui';
import { useApi, useDebouncedValue } from '../hooks/useApi';
import { useCrudPage } from '../hooks/useCrudPage';
import { useToast } from '../hooks/useToast';
import { ApiError, api } from '../lib/api';
import { displayUrl, externalHref, formatDate, isOverdue, relativeDay } from '../lib/format';
import type { Lead, OptionLists } from '../lib/types';

const CONTACT_TYPES = ['Client', 'Prospect', 'Partner'];

export function LeadsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState('all');
  const search = useDebouncedValue(searchInput);
  const toast = useToast();

  const { data: options } = useApi<OptionLists>('/options');
  const statuses = options?.lead_status ?? [];
  const sources = options?.lead_source ?? [];

  const crud = useCrudPage<Lead>('/leads', 'Lead', { search, status });
  const [converting, setConverting] = useState<Lead | null>(null);
  const [convertType, setConvertType] = useState('Client');
  const [convertBusy, setConvertBusy] = useState(false);

  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true, placeholder: 'Jordan Ellis' },
    { name: 'business_name', label: 'Business name', placeholder: 'Ellis Contracting' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'website', label: 'Website', type: 'url', placeholder: 'https://' },
    {
      name: 'source',
      label: 'Source',
      type: 'select',
      options: sources.map((value) => ({ value, label: value })),
      emptyLabel: '— Not set —',
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: statuses.map((value) => ({ value, label: value })),
    },
    {
      name: 'follow_up_date',
      label: 'Follow-up date',
      type: 'date',
      help: 'Due follow-ups appear on the dashboard.',
    },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 5 },
  ];

  const runConvert = async () => {
    if (!converting) return;
    setConvertBusy(true);
    try {
      await api.post(`/leads/${converting.id}/convert`, { contact_type: convertType });
      setConverting(null);
      crud.reload();
      toast.success(`${converting.name} is now a CRM ${convertType.toLowerCase()}.`);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not convert this lead.',
      );
    } finally {
      setConvertBusy(false);
    }
  };

  const filtered = crud.rows;
  const hasFilters = search !== '' || status !== 'all';

  return (
    <>
      <PageIntro
        actions={
          <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            Add lead
          </button>
        }
      />

      <div className="card">
        <Toolbar>
          <SearchInput
            label="Search leads"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search name, business, email…"
          />
          <FilterSelect
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={statuses.map((value) => ({ value, label: value }))}
            allLabel="All statuses"
          />
          <ResultCount count={filtered.length} noun="lead" />
        </Toolbar>

        {crud.loading && filtered.length === 0 ? (
          <LoadingState label="Loading leads…" />
        ) : crud.error ? (
          <ErrorState message={crud.error} onRetry={crud.reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title={hasFilters ? 'No leads match your filters' : 'No leads yet'}
            description={
              hasFilters
                ? 'Try a different search term or clear the status filter.'
                : 'Add the first lead you are chasing. You can record where it came from, set a follow-up date, and convert it to a CRM contact when it lands.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearchInput('');
                    setStatus('all');
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add lead
                </button>
              )
            }
          />
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Leads</caption>
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="th">Lead</th>
                  <th scope="col" className="th">Contact</th>
                  <th scope="col" className="th">Source</th>
                  <th scope="col" className="th">Status</th>
                  <th scope="col" className="th">Follow-up</th>
                  <th scope="col" className="th">Created</th>
                  <th scope="col" className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="td">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {lead.name}
                      </p>
                      {lead.business_name ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {lead.business_name}
                        </p>
                      ) : null}
                      {lead.notes ? (
                        <p className="mt-1 line-clamp-2 max-w-xs text-xs text-slate-500 dark:text-slate-400">
                          {lead.notes}
                        </p>
                      ) : null}
                      {lead.converted_contact_name ? (
                        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                          Converted → {lead.converted_contact_name}
                        </p>
                      ) : null}
                    </td>
                    <td className="td">
                      <div className="space-y-0.5 text-xs">
                        {lead.email ? (
                          <a className="link block" href={`mailto:${lead.email}`}>
                            {lead.email}
                          </a>
                        ) : null}
                        {lead.phone ? (
                          <a className="link block" href={`tel:${lead.phone}`}>
                            {lead.phone}
                          </a>
                        ) : null}
                        {lead.website ? (
                          <a
                            className="link block"
                            href={externalHref(lead.website)}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {displayUrl(lead.website)}
                          </a>
                        ) : null}
                        {!lead.email && !lead.phone && !lead.website ? (
                          <span className="text-slate-400">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="td">{lead.source ?? '—'}</td>
                    <td className="td">
                      <Badge>{lead.status}</Badge>
                    </td>
                    <td className="td">
                      {lead.follow_up_date ? (
                        <>
                          <span className="block">{formatDate(lead.follow_up_date)}</span>
                          <span
                            className={`text-xs ${
                              isOverdue(lead.follow_up_date)
                                ? 'font-medium text-amber-700 dark:text-amber-400'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {relativeDay(lead.follow_up_date)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td whitespace-nowrap">{formatDate(lead.created_at)}</td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={() => {
                            setConvertType('Client');
                            setConverting(lead);
                          }}
                          disabled={Boolean(lead.converted_contact_id)}
                          aria-label={`Convert ${lead.name} to a CRM contact`}
                          title={
                            lead.converted_contact_id
                              ? 'Already converted'
                              : 'Convert to CRM contact'
                          }
                        >
                          <ArrowRightLeft className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={() => crud.openEdit(lead)}
                          aria-label={`Edit ${lead.name}`}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                          onClick={() => crud.requestDelete(lead)}
                          aria-label={`Delete ${lead.name}`}
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
        title={crud.editing ? 'Edit lead' : 'Add lead'}
        description={
          crud.editing
            ? 'Update the details for this lead.'
            : 'Record a new opportunity. Only the name is required.'
        }
      >
        <RecordForm
          key={crud.editing?.id ?? 'new'}
          fields={fields}
          record={crud.editing as unknown as Record<string, unknown> | null}
          submitLabel={crud.editing ? 'Save changes' : 'Add lead'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      <Modal
        open={Boolean(converting)}
        onClose={() => !convertBusy && setConverting(null)}
        title="Convert lead to CRM record"
        description={
          converting
            ? `${converting.name} will be added to your CRM. The lead stays in the list, linked to the new record.`
            : ''
        }
        size="sm"
      >
        <div className="px-5 py-4">
          <label className="label" htmlFor="convert-type">
            Add to CRM as
          </label>
          <select
            id="convert-type"
            className="select"
            value={convertType}
            onChange={(event) => setConvertType(event.target.value)}
          >
            {CONTACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Converting to a client also marks the lead as Won.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setConverting(null)}
            disabled={convertBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={runConvert}
            disabled={convertBusy}
          >
            {convertBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Convert lead
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete lead"
        message={`Delete ${crud.deleting?.name ?? 'this lead'}? This cannot be undone.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
