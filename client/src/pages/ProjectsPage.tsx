import { useState } from 'react';
import { FolderKanban, LayoutList, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { formatDate, isOverdue } from '../lib/format';
import type { Contact, OptionLists, Project } from '../lib/types';

export function ProjectsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState('all');
  const [view, setView] = useState<'list' | 'board'>('list');
  const search = useDebouncedValue(searchInput);

  const { data: options } = useApi<OptionLists>('/options');
  const { data: contacts } = useApi<Contact[]>('/contacts');
  const statuses = options?.project_status ?? [];

  const crud = useCrudPage<Project>('/projects', 'Project', { search, status });

  const fields: FieldDef[] = [
    { name: 'name', label: 'Project name', required: true, full: true },
    {
      name: 'contact_id',
      label: 'Client',
      type: 'select',
      options: (contacts ?? []).map((contact) => ({
        value: String(contact.id),
        label: contact.business ? `${contact.name} — ${contact.business}` : contact.name,
      })),
      emptyLabel: '— No client —',
      help:
        contacts && contacts.length === 0
          ? 'Add a contact in the CRM first to assign a client.'
          : undefined,
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: statuses.map((value) => ({ value, label: value })),
    },
    { name: 'start_date', label: 'Start date', type: 'date' },
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 5 },
  ];

  const hasFilters = search !== '' || status !== 'all';

  const emptyOrError =
    crud.loading && crud.rows.length === 0 ? (
      <LoadingState label="Loading projects…" />
    ) : crud.error ? (
      <ErrorState message={crud.error} onRetry={crud.reload} />
    ) : crud.rows.length === 0 ? (
      <EmptyState
        icon={FolderKanban}
        title={hasFilters ? 'No projects match your filters' : 'No projects yet'}
        description={
          hasFilters
            ? 'Try a different search term or clear the status filter.'
            : 'Add the work you have on. Assign a client, set a due date, and track it from planned through to completed.'
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
              Add project
            </button>
          )
        }
      />
    ) : null;

  return (
    <>
      <PageIntro
        actions={
          <>
            <div
              className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700"
              role="group"
              aria-label="Change project view"
            >
              {(
                [
                  ['list', 'List', LayoutList],
                  ['board', 'Board', FolderKanban],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={view === key}
                  className={`btn btn-sm ${
                    view === key
                      ? 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Add project
            </button>
          </>
        }
      />

      <div className="card">
        <Toolbar>
          <SearchInput
            label="Search projects"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search project or client…"
          />
          <FilterSelect
            label="Filter by status"
            value={status}
            onChange={setStatus}
            options={statuses.map((value) => ({ value, label: value }))}
            allLabel="All statuses"
          />
          <ResultCount count={crud.rows.length} noun="project" />
        </Toolbar>

        {emptyOrError ??
          (view === 'list' ? (
            <TableScroll>
              <table className="w-full border-collapse">
                <caption className="sr-only">Projects</caption>
                <thead className="border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th scope="col" className="th">Project</th>
                    <th scope="col" className="th">Client</th>
                    <th scope="col" className="th">Status</th>
                    <th scope="col" className="th">Start</th>
                    <th scope="col" className="th">Due</th>
                    <th scope="col" className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {crud.rows.map((project) => (
                    <tr key={project.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="td">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {project.name}
                        </p>
                        {project.notes ? (
                          <p className="mt-1 line-clamp-2 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                            {project.notes}
                          </p>
                        ) : null}
                      </td>
                      <td className="td">{project.contact_name ?? '—'}</td>
                      <td className="td">
                        <Badge>{project.status}</Badge>
                      </td>
                      <td className="td whitespace-nowrap">{formatDate(project.start_date)}</td>
                      <td className="td whitespace-nowrap">
                        <span
                          className={
                            isOverdue(project.due_date) &&
                            project.status !== 'Completed' &&
                            project.status !== 'Cancelled'
                              ? 'font-medium text-amber-700 dark:text-amber-400'
                              : ''
                          }
                        >
                          {formatDate(project.due_date)}
                        </span>
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            onClick={() => crud.openEdit(project)}
                            aria-label={`Edit ${project.name}`}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                            onClick={() => crud.requestDelete(project)}
                            aria-label={`Delete ${project.name}`}
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
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-5">
              {statuses.map((columnStatus) => {
                const items = crud.rows.filter((p) => p.status === columnStatus);
                return (
                  <section key={columnStatus} className="flex flex-col gap-2">
                    <h2 className="flex items-center justify-between text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                      {columnStatus}
                      <span className="tabular-nums">{items.length}</span>
                    </h2>
                    {items.length === 0 ? (
                      <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400 dark:border-slate-700">
                        None
                      </p>
                    ) : (
                      items.map((project) => (
                        <article
                          key={project.id}
                          className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                              {project.name}
                            </p>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm -m-1 shrink-0 p-1"
                              onClick={() => crud.openEdit(project)}
                              aria-label={`Edit ${project.name}`}
                            >
                              <Pencil className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                          {project.contact_name ? (
                            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              {project.contact_name}
                            </p>
                          ) : null}
                          {project.due_date ? (
                            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                              Due {formatDate(project.due_date)}
                            </p>
                          ) : null}
                        </article>
                      ))
                    )}
                  </section>
                );
              })}
            </div>
          ))}
      </div>

      <Modal
        open={crud.formOpen}
        onClose={crud.closeForm}
        title={crud.editing ? 'Edit project' : 'Add project'}
        description={
          crud.editing ? 'Update this project.' : 'Only the project name is required.'
        }
      >
        <RecordForm
          key={crud.editing?.id ?? 'new'}
          fields={fields}
          record={crud.editing as unknown as Record<string, unknown> | null}
          submitLabel={crud.editing ? 'Save changes' : 'Add project'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete project"
        message={`Delete ${crud.deleting?.name ?? 'this project'}? This cannot be undone.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
