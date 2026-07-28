import { Link } from 'react-router-dom';
import {
  CalendarClock,
  FolderKanban,
  Inbox,
  ListChecks,
  PackageSearch,
  UserPlus,
  Users,
} from 'lucide-react';
import { PageIntro } from '../components/PageIntro';
import { Badge, EmptyState, ErrorState, LoadingState, StatCard } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { formatDate, formatTime, relativeDay } from '../lib/format';
import type { DashboardData } from '../lib/types';

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="card flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {action ? (
          <Link to={action.to} className="text-xs font-medium link">
            {action.label}
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function PanelEmpty({ message }: { message: string }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
      {message}
    </p>
  );
}

export function DashboardPage() {
  const { data, loading, error, reload } = useApi<DashboardData>('/dashboard');

  if (loading && !data) {
    return (
      <>
        <PageIntro />
        <div className="card">
          <LoadingState label="Loading your dashboard…" />
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageIntro />
        <div className="card">
          <ErrorState message={error ?? 'Dashboard data unavailable.'} onRetry={reload} />
        </div>
      </>
    );
  }

  const { metrics } = data;

  return (
    <>
      <PageIntro />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard icon={UserPlus} label="Open leads" value={metrics.open_leads} hint="Not yet won or lost" />
        <StatCard icon={Users} label="Active clients" value={metrics.active_clients} hint="Contacts marked as clients" />
        <StatCard icon={FolderKanban} label="Active projects" value={metrics.active_projects} hint="Currently in progress" />
        <StatCard icon={ListChecks} label="Follow-ups due" value={metrics.follow_ups_due} hint="Due today or overdue" />
        <StatCard icon={CalendarClock} label="Upcoming events" value={metrics.upcoming_events} hint="Today and later" />
        <StatCard icon={PackageSearch} label="Imported eBay listings" value={metrics.imported_listings} hint="Across all categories" />
      </div>

      {data.is_empty ? (
        <div className="card mt-6">
          <EmptyState
            icon={Inbox}
            title="Wheelhouse is ready and empty"
            description="Nothing has been added yet. Start by adding a lead or a contact — the dashboard fills in as you use the app."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link to="/leads" className="btn btn-primary">
                  <UserPlus className="size-4" aria-hidden="true" />
                  Add your first lead
                </Link>
                <Link to="/crm" className="btn btn-secondary">
                  <Users className="size-4" aria-hidden="true" />
                  Add a contact
                </Link>
              </div>
            }
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Follow-ups due" action={{ to: '/leads', label: 'View leads' }}>
            {data.follow_ups.length === 0 ? (
              <PanelEmpty message="Nothing is due right now." />
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.follow_ups.map((item) => (
                  <li key={`${item.kind}-${item.id}`} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {item.label}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {item.detail || (item.kind === 'lead' ? 'Lead' : 'Contact')}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400">
                        {relativeDay(item.due_date)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Upcoming events" action={{ to: '/calendar', label: 'Open calendar' }}>
            {data.upcoming_events.length === 0 ? (
              <PanelEmpty message="No events scheduled yet." />
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.upcoming_events.map((event) => (
                  <li key={event.id} className="px-4 py-3">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {event.title}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span>{formatDate(event.date)}</span>
                      {event.time ? <span>{formatTime(event.time)}</span> : null}
                      <Badge>{event.event_type}</Badge>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Projects in progress" action={{ to: '/projects', label: 'View projects' }}>
            {data.active_projects.length === 0 ? (
              <PanelEmpty message="No active projects." />
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.active_projects.map((project) => (
                  <li key={project.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {project.name}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {project.contact_name ?? 'No client assigned'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge>{project.status}</Badge>
                        {project.due_date ? (
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Due {formatDate(project.due_date)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
