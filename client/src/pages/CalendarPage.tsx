import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { PageIntro } from '../components/PageIntro';
import { RecordForm } from '../components/RecordForm';
import type { FieldDef } from '../components/RecordForm';
import { Badge, EmptyState, ErrorState, LoadingState } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useCrudPage } from '../hooks/useCrudPage';
import { formatDate, formatTime, toIsoDate, todayIso } from '../lib/format';
import type { CalendarEvent, Contact, OptionLists, Project } from '../lib/types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRID_DAYS = 42; // Six weeks always fits a month.

export function CalendarPage() {
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [formDate, setFormDate] = useState(todayIso());

  const { gridStart, gridDays, monthStart, monthEnd } = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const start = new Date(cursor.year, cursor.month, 1 - first.getDay());
    const days = Array.from({ length: GRID_DAYS }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
    return {
      gridStart: start,
      gridDays: days,
      monthStart: toIsoDate(first),
      monthEnd: toIsoDate(new Date(cursor.year, cursor.month + 1, 0)),
    };
  }, [cursor]);

  const crud = useCrudPage<CalendarEvent>('/events', 'Event', {
    from: toIsoDate(gridStart),
    to: toIsoDate(gridDays[GRID_DAYS - 1]),
  });

  const { data: options } = useApi<OptionLists>('/options');
  const { data: contacts } = useApi<Contact[]>('/contacts');
  const { data: projects } = useApi<Project[]>('/projects');

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of crud.rows) {
      const list = map.get(event.date) ?? [];
      list.push(event);
      map.set(event.date, list);
    }
    return map;
  }, [crud.rows]);

  const monthEvents = crud.rows.filter(
    (event) => event.date >= monthStart && event.date <= monthEnd,
  );

  const fields: FieldDef[] = [
    { name: 'title', label: 'Title', required: true, full: true },
    { name: 'date', label: 'Date', type: 'date', required: true },
    { name: 'time', label: 'Time', type: 'time', help: 'Optional — leave blank for all day.' },
    {
      name: 'event_type',
      label: 'Event type',
      type: 'select',
      required: true,
      options: (options?.event_type ?? []).map((value) => ({ value, label: value })),
    },
    {
      name: 'contact_id',
      label: 'Related contact',
      type: 'select',
      options: (contacts ?? []).map((contact) => ({
        value: String(contact.id),
        label: contact.name,
      })),
      emptyLabel: '— None —',
    },
    {
      name: 'project_id',
      label: 'Related project',
      type: 'select',
      options: (projects ?? []).map((project) => ({
        value: String(project.id),
        label: project.name,
      })),
      emptyLabel: '— None —',
    },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 4 },
  ];

  const openForDate = (date: string) => {
    setFormDate(date);
    crud.openCreate();
  };

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const today = todayIso();

  const shiftMonth = (delta: number) =>
    setCursor((current) => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });

  return (
    <>
      <PageIntro
        actions={
          <button type="button" className="btn btn-primary" onClick={() => openForDate(today)}>
            <Plus className="size-4" aria-hidden="true" />
            Add event
          </button>
        }
      />

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {monthLabel}
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}
            >
              Today
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {crud.error ? (
          <ErrorState message={crud.error} onRetry={crud.reload} />
        ) : (
          <div className="overflow-x-auto p-4">
            <div className="min-w-160">
              <div className="grid grid-cols-7 gap-px">
                {WEEKDAYS.map((day) => (
                  <div
                    key={day}
                    className="pb-2 text-center text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                  >
                    {day}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800">
                {gridDays.map((date) => {
                  const iso = toIsoDate(date);
                  const inMonth = date.getMonth() === cursor.month;
                  const dayEvents = byDate.get(iso) ?? [];
                  return (
                    <div
                      key={iso}
                      className={`min-h-24 p-1.5 ${
                        inMonth
                          ? 'bg-white dark:bg-slate-900'
                          : 'bg-slate-50 dark:bg-slate-950'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => openForDate(iso)}
                        className={`mb-1 flex size-6 cursor-pointer items-center justify-center rounded text-xs font-medium tabular-nums transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 ${
                          iso === today
                            ? 'bg-brand-600 text-white hover:bg-brand-700'
                            : inMonth
                              ? 'text-slate-700 dark:text-slate-300'
                              : 'text-slate-400 dark:text-slate-600'
                        }`}
                        aria-label={`Add an event on ${formatDate(iso)}`}
                      >
                        {date.getDate()}
                      </button>
                      <ul className="space-y-1">
                        {dayEvents.slice(0, 3).map((event) => (
                          <li key={event.id}>
                            <button
                              type="button"
                              onClick={() => crud.openEdit(event)}
                              className="block w-full cursor-pointer truncate rounded bg-brand-50 px-1.5 py-0.5 text-left text-xs text-brand-800 hover:bg-brand-100 dark:bg-brand-950 dark:text-brand-200 dark:hover:bg-brand-900"
                              title={event.title}
                            >
                              {event.time ? `${formatTime(event.time)} ` : ''}
                              {event.title}
                            </button>
                          </li>
                        ))}
                        {dayEvents.length > 3 ? (
                          <li className="px-1.5 text-xs text-slate-500 dark:text-slate-400">
                            +{dayEvents.length - 3} more
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card mt-6">
        <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Events in {monthLabel}
          </h2>
        </header>

        {crud.loading && crud.rows.length === 0 ? (
          <LoadingState label="Loading events…" />
        ) : monthEvents.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No events this month"
            description="Add meetings, follow-ups, networking events, project deadlines and reminders. Click any day in the grid above to add an event on that date."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => openForDate(today)}
              >
                <Plus className="size-4" aria-hidden="true" />
                Add event
              </button>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {monthEvents.map((event) => (
              <li key={event.id} className="flex items-start gap-4 px-4 py-3">
                <div className="w-24 shrink-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {formatDate(event.date)}
                  </p>
                  {event.time ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {formatTime(event.time)}
                    </p>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {event.title}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <Badge>{event.event_type}</Badge>
                    {event.contact_name ? <span>{event.contact_name}</span> : null}
                    {event.project_name ? <span>· {event.project_name}</span> : null}
                  </p>
                  {event.notes ? (
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {event.notes}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    onClick={() => crud.openEdit(event)}
                    aria-label={`Edit ${event.title}`}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                    onClick={() => crud.requestDelete(event)}
                    aria-label={`Delete ${event.title}`}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={crud.formOpen}
        onClose={crud.closeForm}
        title={crud.editing ? 'Edit event' : 'Add event'}
        description={
          crud.editing
            ? 'Update this event.'
            : 'Events live inside Wheelhouse only — nothing is sent to an external calendar.'
        }
      >
        <RecordForm
          key={crud.editing?.id ?? `new-${formDate}`}
          fields={fields}
          record={
            (crud.editing as unknown as Record<string, unknown> | null) ?? {
              date: formDate,
              event_type: 'Meeting',
            }
          }
          submitLabel={crud.editing ? 'Save changes' : 'Add event'}
          onSubmit={crud.save}
          onCancel={crud.closeForm}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(crud.deleting)}
        title="Delete event"
        message={`Delete "${crud.deleting?.title ?? 'this event'}"? This cannot be undone.`}
        onConfirm={crud.confirmDelete}
        onCancel={crud.cancelDelete}
      />
    </>
  );
}
