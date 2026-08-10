import type { ComponentType, ReactNode } from 'react';
import { AlertTriangle, Loader2, RotateCw, Search, X } from 'lucide-react';

/* ------------------------------------------------------------------ badges */

/* Tones are named for what they MEAN, not for the hue they happen to be.

   A map keyed `blue`/`rose` pins the palette in place: re-theming then means
   editing every status that mentions a colour, and "Lost is rose" stops being
   true the moment rose is not the danger colour. Keyed `info`/`danger`, the map
   outlives any palette — and each entry resolves to one of the `.badge-*`
   classes, so the container/on-container pairing (the part that has to stay
   legible in both themes) lives in one place instead of six. */
const TONES = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  accent: 'badge-accent',
  danger: 'badge-danger',
} as const;

export type BadgeTone = keyof typeof TONES;

/** Keeps status colours consistent everywhere a status is shown. */
const STATUS_TONES: Record<string, BadgeTone> = {
  // Leads
  New: 'info',
  Contacted: 'neutral',
  'Follow-up': 'warning',
  Qualified: 'accent',
  Won: 'success',
  Lost: 'danger',
  // Contacts
  Prospect: 'info',
  Client: 'success',
  Partner: 'accent',
  Active: 'success',
  Inactive: 'neutral',
  Archived: 'neutral',
  // Projects
  Planned: 'neutral',
  Waiting: 'warning',
  Completed: 'info',
  Cancelled: 'danger',
  // Events
  Meeting: 'info',
  'Networking event': 'accent',
  'Project deadline': 'danger',
  Reminder: 'neutral',
};

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  const key = tone ?? STATUS_TONES[String(children)] ?? 'neutral';
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
      <p className="max-w-2xl text-sm text-on-surface-variant">
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
      className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-on-surface-muted"
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
      <AlertTriangle className="size-6 text-danger-text" aria-hidden="true" />
      <p className="max-w-md text-sm text-on-surface-variant">{message}</p>
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
      <div className="mb-4 rounded-full bg-surface-container p-3">
        <Icon className="size-6 text-on-surface-muted" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-on-surface">
        {title}
      </h3>
      <p className="mt-1.5 max-w-md text-sm text-on-surface-variant">
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
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-on-surface-muted"
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
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-1 text-on-surface-muted hover:text-on-surface-variant"
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
    <div className="flex flex-col gap-3 border-b border-outline-variant p-4 sm:flex-row sm:flex-wrap sm:items-center">
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
    <p className="text-xs text-on-surface-muted sm:ml-auto" aria-live="polite">
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
      <div className="flex items-center gap-2 text-on-surface-muted">
        <Icon className="size-4" aria-hidden="true" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-on-surface">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-on-surface-muted">{hint}</p>
      ) : null}
    </div>
  );
}
