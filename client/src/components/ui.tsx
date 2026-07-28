import type { ComponentType, ReactNode } from 'react';
import { AlertTriangle, Loader2, RotateCw, Search, X } from 'lucide-react';

/* ------------------------------------------------------------------ badges */

const TONES: Record<string, string> = {
  slate:
    'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/25',
  emerald:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/25',
  amber:
    'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/25',
  violet:
    'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-400/25',
  rose: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-400/25',
};

/** Keeps status colours consistent everywhere a status is shown. */
const STATUS_TONES: Record<string, keyof typeof TONES> = {
  // Leads
  New: 'blue',
  Contacted: 'slate',
  'Follow-up': 'amber',
  Qualified: 'violet',
  Won: 'emerald',
  Lost: 'rose',
  // Contacts
  Prospect: 'blue',
  Client: 'emerald',
  Partner: 'violet',
  Active: 'emerald',
  Inactive: 'slate',
  Archived: 'slate',
  // Projects
  Planned: 'slate',
  Waiting: 'amber',
  Completed: 'blue',
  Cancelled: 'rose',
  // Events
  Meeting: 'blue',
  'Networking event': 'violet',
  'Project deadline': 'rose',
  Reminder: 'slate',
};

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  const key = tone ?? STATUS_TONES[String(children)] ?? 'slate';
  return <span className={`badge ${TONES[key]}`}>{children}</span>;
}

/* ------------------------------------------------------------- page header */

export function PageHeader({
  description,
  actions,
}: {
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-400">
        {description}
      </p>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-slate-500 dark:text-slate-400"
      role="status"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" role="alert">
      <AlertTriangle className="size-6 text-red-600 dark:text-red-400" aria-hidden="true" />
      <p className="max-w-md text-sm text-slate-700 dark:text-slate-300">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <RotateCw className="size-4" aria-hidden="true" />
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 rounded-full bg-slate-100 p-3 dark:bg-slate-800">
        <Icon className="size-6 text-slate-500 dark:text-slate-400" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-1.5 max-w-md text-sm text-slate-600 dark:text-slate-400">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ search */

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        type="search"
        className="input pl-9"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-label="Clear search"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel = 'All',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
}) {
  return (
    <select
      className="select w-full sm:w-44"
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="all">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Search + filters row that sits above a table. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:flex-wrap sm:items-center dark:border-slate-800">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function ResultCount({ count, noun }: { count: number; noun: string }) {
  return (
    <p className="text-xs text-slate-500 sm:ml-auto dark:text-slate-400" aria-live="polite">
      {count} {count === 1 ? noun : `${noun}s`}
    </p>
  );
}

/* -------------------------------------------------------------- stat tiles */

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
        <Icon className="size-4" aria-hidden="true" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-slate-50">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}
