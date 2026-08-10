import { useState } from 'react';
import { Pencil, Plus, StickyNote, Tag, Trash2 } from 'lucide-react';
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
  Toolbar,
} from '../components/ui';
import { useApi, useDebouncedValue } from '../hooks/useApi';
import { useCrudPage } from '../hooks/useCrudPage';
import { formatDateTime, parseTags } from '../lib/format';
import type { Contact, EbayCategory, Lead, Note, Project } from '../lib/types';

export function NotesPage() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput);

  const crud = useCrudPage<Note>('/notes', 'Note', { search });
  const { data: contacts } = useApi<Contact[]>('/contacts');
  const { data: leads } = useApi<Lead[]>('/leads');
  const { data: projects } = useApi<Project[]>('/projects');
  const { data: categories } = useApi<EbayCategory[]>('/ebay/categories');

  const fields: FieldDef[] = [
    { name: 'title', label: 'Title', required: true, full: true },
    { name: 'body', label: 'Note', type: 'textarea', rows: 8 },
    {
      name: 'tags',
      label: 'Tags',
      full: true,
      placeholder: 'pricing, follow-up, ideas',
      help: 'Separate tags with commas.',
    },
    {
      name: 'contact_id',
      label: 'Related contact',
      type: 'select',
      options: (contacts ?? []).map((c) => ({ value: String(c.id), label: c.name })),
      emptyLabel: '— None —',
    },
    {
      name: 'lead_id',
      label: 'Related lead',
      type: 'select',
      options: (leads ?? []).map((l) => ({ value: String(l.id), label: l.name })),
      emptyLabel: '— None —',
    },
    {
      name: 'project_id',
      label: 'Related project',
      type: 'select',
      options: (projects ?? []).map((p) => ({ value: String(p.id), label: p.name })),
      emptyLabel: '— None —',
    },
    {
      name: 'ebay_category_id',
      label: 'eBay research category',
      type: 'select',
      options: (categories ?? []).map((c) => ({
        value: String(c.id),
        label: `${c.group_name} / ${c.name}`,
      })),
      emptyLabel: '— None —',
    },
  ];

  // The API stores tags as JSON; the form edits them as a comma-separated list.
  const formRecord = crud.editing
    ? { ...crud.editing, tags: parseTags(crud.editing.tags).join(', ') }
    : null;

  return (
    <>
      <PageIntro
        actions={
          <button type="button" className="btn btn-primary" onClick={crud.openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            Add note
          </button>
        }
      />

      <div className="card">
        <Toolbar>
          <SearchInput
            label="Search notes"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search title, text or tag…"
          />
          <ResultCount count={crud.rows.length} noun="note" />
        </Toolbar>

        {crud.loading && crud.rows.length === 0 ? (
          <LoadingState label="Loading notes…" />
        ) : crud.error ? (
          <ErrorState message={crud.error} onRetry={crud.reload} />
        ) : crud.rows.length === 0 ? (
          <EmptyState
            icon={StickyNote}
            title={search ? 'No notes match your search' : 'No notes yet'}
            description={
              search
                ? 'Try a different search term or tag.'
                : 'Write down anything worth keeping — call notes, pricing thoughts, reminders. Tag notes and link them to a contact, lead, project or eBay research category.'
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
                  Add note
                </button>
              )
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
            {crud.rows.map((note) => {
              const tags = parseTags(note.tags);
              const links = [
                note.contact_name ? `Contact: ${note.contact_name}` : null,
                note.lead_name ? `Lead: ${note.lead_name}` : null,
                note.project_name ? `Project: ${note.project_name}` : null,
                note.ebay_category_name ? `eBay: ${note.ebay_category_name}` : null,
              ].filter(Boolean) as string[];

              return (
                <li
                  key={note.id}
                  className="flex flex-col rounded-lg border border-outline-variant bg-background p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium text-on-surface">
                      {note.title}
                    </h3>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm p-1"
                        onClick={() => crud.openEdit(note)}
                        aria-label={`Edit ${note.title}`}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm p-1 text-danger-text"
                        onClick={() => crud.requestDelete(note)}
                        aria-label={`Delete ${note.title}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {note.body ? (
                    <p className="mt-2 line-clamp-6 text-sm whitespace-pre-wrap text-on-surface-variant">
                      {note.body}
                    </p>
                  ) : null}

                  {tags.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSearchInput(tag)}
                          className="badge cursor-pointer bg-surface-container text-on-surface-variant ring-outline hover:bg-surface-container-high"
                          aria-label={`Filter notes by the tag ${tag}`}
                        >
                          <Tag className="size-3" aria-hidden="true" />
                          {tag}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {links.length ? (
                    <p className="mt-3 text-xs text-on-surface-muted">
                      {links.join(' · ')}
                    </p>
                  ) : null}

                  <p className="mt-3 border-t border-outline-variant pt-2 text-xs text-on-surface-muted">
                    Updated {formatDateTime(note.updated_at)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal
        open={crud.formOpen}
        onClose={crud.closeForm}
        title={crud.editing ? 'Edit note' : 'Add note'}
        description={crud.editing ? 'Update this note.' : 'Only a title is required.'}
      >
        <RecordForm
          key={crud.editing?.id ?? 'new'}
          fields={fields}
          record={formRecord as unknown as Record<string, unknown> | null}
          submitLabel={crud.editing ? 'Save changes' : 'Add note'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete note"
        message={`Delete "${crud.deleting?.title ?? 'this note'}"? This cannot be undone.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
