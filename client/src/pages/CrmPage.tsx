import { useEffect, useState } from 'react';
import { Building2, Eye, Pencil, Plus, Trash2, Users } from 'lucide-react';
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
import { api } from '../lib/api';
import { displayUrl, externalHref, formatDate, isOverdue, relativeDay } from '../lib/format';
import type { Contact, OptionLists, Project } from '../lib/types';

/** Detail panel: notes, follow-up dates and the projects attached to a contact. */
function ContactDetail({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<Project[]>(`/contacts/${contact.id}/projects`)
      .then((rows) => active && setProjects(rows))
      .catch(() => active && setError('Could not load projects for this contact.'));
    return () => {
      active = false;
    };
  }, [contact.id]);

  return (
    <Modal open onClose={onClose} title={contact.name} description={contact.business ?? undefined}>
      <div className="space-y-6 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <Badge>{contact.contact_type}</Badge>
          <Badge>{contact.status}</Badge>
        </div>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[
            ['Email', contact.email, contact.email ? `mailto:${contact.email}` : null],
            ['Phone', contact.phone, contact.phone ? `tel:${contact.phone}` : null],
            [
              'Website',
              contact.website ? displayUrl(contact.website) : null,
              contact.website ? externalHref(contact.website) : null,
            ],
            ['Last contacted', formatDate(contact.last_contacted_date), null],
            ['Next follow-up', formatDate(contact.next_follow_up_date), null],
          ].map(([label, value, href]) => (
            <div key={label as string}>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                {label}
              </dt>
              <dd className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                {value ? (
                  href ? (
                    <a className="link" href={href as string} target="_blank" rel="noreferrer noopener">
                      {value}
                    </a>
                  ) : (
                    value
                  )
                ) : (
                  '—'
                )}
              </dd>
            </div>
          ))}
        </dl>

        <div>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Notes
          </h3>
          <p className="text-sm whitespace-pre-wrap text-slate-800 dark:text-slate-200">
            {contact.notes || 'No notes for this contact yet.'}
          </p>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Projects
          </h3>
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : projects === null ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No projects are assigned to this contact yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {projects.map((project) => (
                <li key={project.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate text-sm text-slate-800 dark:text-slate-200">
                    {project.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {project.due_date ? (
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Due {formatDate(project.due_date)}
                      </span>
                    ) : null}
                    <Badge>{project.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex justify-end border-t border-slate-200 px-5 py-4 dark:border-slate-800">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

export function CrmPage() {
  const [searchInput, setSearchInput] = useState('');
  const [contactType, setContactType] = useState('all');
  const [status, setStatus] = useState('all');
  const search = useDebouncedValue(searchInput);
  const [viewing, setViewing] = useState<Contact | null>(null);

  const { data: options } = useApi<OptionLists>('/options');
  const types = options?.contact_type ?? [];
  const statuses = options?.contact_status ?? [];

  const crud = useCrudPage<Contact>('/contacts', 'Contact', {
    search,
    contact_type: contactType,
    status,
  });

  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true },
    { name: 'business', label: 'Business' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'website', label: 'Website', type: 'url', placeholder: 'https://' },
    {
      name: 'contact_type',
      label: 'Contact type',
      type: 'select',
      required: true,
      options: types.map((value) => ({ value, label: value })),
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: statuses.map((value) => ({ value, label: value })),
    },
    { name: 'last_contacted_date', label: 'Last contacted', type: 'date' },
    {
      name: 'next_follow_up_date',
      label: 'Next follow-up',
      type: 'date',
      help: 'Due follow-ups appear on the dashboard.',
    },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 5 },
  ];

  const hasFilters = search !== '' || contactType !== 'all' || status !== 'all';

  return (
    <>
      <PageIntro
        actions={
          <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            Add contact
          </button>
        }
      />

      <div className="card">
        <Toolbar>
          <SearchInput
            label="Search contacts"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search name, business, email…"
          />
          <FilterSelect
            label="Filter by contact type"
            value={contactType}
            onChange={setContactType}
            options={types.map((value) => ({ value, label: value }))}
            allLabel="All types"
          />
          <FilterSelect
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={statuses.map((value) => ({ value, label: value }))}
            allLabel="All statuses"
          />
          <ResultCount count={crud.rows.length} noun="contact" />
        </Toolbar>

        {crud.loading && crud.rows.length === 0 ? (
          <LoadingState label="Loading contacts…" />
        ) : crud.error ? (
          <ErrorState message={crud.error} onRetry={crud.reload} />
        ) : crud.rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={hasFilters ? 'No contacts match your filters' : 'No contacts yet'}
            description={
              hasFilters
                ? 'Try a different search term or clear the filters.'
                : 'Add the people and businesses you work with. Mark each one as a prospect, client or partner, and keep notes and follow-up dates against them.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearchInput('');
                    setContactType('all');
                    setStatus('all');
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add contact
                </button>
              )
            }
          />
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">CRM contacts</caption>
              <thead className="border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th scope="col" className="th">Contact</th>
                  <th scope="col" className="th">Details</th>
                  <th scope="col" className="th">Type</th>
                  <th scope="col" className="th">Status</th>
                  <th scope="col" className="th">Projects</th>
                  <th scope="col" className="th">Next follow-up</th>
                  <th scope="col" className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {crud.rows.map((contact) => (
                  <tr key={contact.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="td">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {contact.name}
                      </p>
                      {contact.business ? (
                        <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                          <Building2 className="size-3" aria-hidden="true" />
                          {contact.business}
                        </p>
                      ) : null}
                    </td>
                    <td className="td">
                      <div className="space-y-0.5 text-xs">
                        {contact.email ? (
                          <a className="link block" href={`mailto:${contact.email}`}>
                            {contact.email}
                          </a>
                        ) : null}
                        {contact.phone ? (
                          <a className="link block" href={`tel:${contact.phone}`}>
                            {contact.phone}
                          </a>
                        ) : null}
                        {!contact.email && !contact.phone ? (
                          <span className="text-slate-400">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="td">
                      <Badge>{contact.contact_type}</Badge>
                    </td>
                    <td className="td">
                      <Badge>{contact.status}</Badge>
                    </td>
                    <td className="td tabular-nums">{contact.project_count}</td>
                    <td className="td">
                      {contact.next_follow_up_date ? (
                        <>
                          <span className="block">{formatDate(contact.next_follow_up_date)}</span>
                          <span
                            className={`text-xs ${
                              isOverdue(contact.next_follow_up_date)
                                ? 'font-medium text-amber-700 dark:text-amber-400'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {relativeDay(contact.next_follow_up_date)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={() => setViewing(contact)}
                          aria-label={`View details for ${contact.name}`}
                        >
                          <Eye className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          onClick={() => crud.openEdit(contact)}
                          aria-label={`Edit ${contact.name}`}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                          onClick={() => crud.requestDelete(contact)}
                          aria-label={`Delete ${contact.name}`}
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
        title={crud.editing ? 'Edit contact' : 'Add contact'}
        description={
          crud.editing
            ? 'Update this CRM record.'
            : 'Add someone to your CRM. Only the name is required.'
        }
      >
        <RecordForm
          key={crud.editing?.id ?? 'new'}
          fields={fields}
          record={crud.editing as unknown as Record<string, unknown> | null}
          submitLabel={crud.editing ? 'Save changes' : 'Add contact'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      {viewing ? <ContactDetail contact={viewing} onClose={() => setViewing(null)} /> : null}

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete contact"
        message={`Delete ${crud.deleting?.name ?? 'this contact'}? Projects and events stay, but lose their link to this contact.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
