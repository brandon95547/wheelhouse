/** Display helpers. All dates are stored as plain YYYY-MM-DD strings. */

const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return currency.format(value);
}

/** Parses YYYY-MM-DD as a local date, avoiding the UTC off-by-one. */
export function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = parseDate(value);
  if (!date) return value;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "14:30" → "2:30 PM" */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const todayIso = (): string => new Date().toLocaleDateString('en-CA');

export function toIsoDate(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

/** "Today", "Tomorrow", "3 days overdue", "in 5 days". */
export function relativeDay(value: string | null | undefined): string {
  if (!value) return '';
  const date = parseDate(value);
  if (!date) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  return `in ${days} days`;
}

export function isOverdue(value: string | null | undefined): boolean {
  if (!value) return false;
  return value <= todayIso();
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Shows a URL without the protocol, which reads better in a table. */
export function displayUrl(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Adds a protocol so a bare "example.com" still makes a working link. */
export function externalHref(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
