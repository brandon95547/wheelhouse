import { useState } from 'react';
import { Check, Copy, Database, Monitor, Moon, Puzzle, Sun, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageIntro } from '../components/PageIntro';
import { useApi } from '../hooks/useApi';
import { useTheme } from '../hooks/useTheme';
import type { ThemePreference } from '../hooks/useTheme';
import { useToast } from '../hooks/useToast';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AppInfo } from '../lib/types';

const BACKEND_URL_KEY = 'wheelhouse.backendUrl';
const DEFAULT_BACKEND_URL = 'http://localhost:4000';

function readBackendUrl(): string {
  try {
    return localStorage.getItem(BACKEND_URL_KEY) ?? DEFAULT_BACKEND_URL;
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <header className="border-b border-outline-variant px-5 py-4">
        <h2 className="text-sm font-semibold text-on-surface">{title}</h2>
        <p className="mt-1 text-sm text-on-surface-variant">{description}</p>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const THEME_CHOICES: Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const toast = useToast();
  const info = useApi<AppInfo>('/info');

  const [backendUrl, setBackendUrl] = useState(readBackendUrl);
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const saveBackendUrl = () => {
    const trimmed = backendUrl.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
    try {
      new URL(trimmed);
    } catch {
      toast.error('That is not a valid URL. Use something like http://localhost:4000');
      return;
    }
    setBackendUrl(trimmed);
    try {
      localStorage.setItem(BACKEND_URL_KEY, trimmed);
      toast.success('Backend URL saved. Paste it into the extension popup as well.');
    } catch {
      toast.error('Could not save the URL in this browser.');
    }
  };

  const copyBackendUrl = async () => {
    try {
      await navigator.clipboard.writeText(backendUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to the clipboard. Select and copy the text instead.');
    }
  };

  const clearAllData = async () => {
    try {
      const result = await api.delete<{ message: string }>(
        '/data',
        undefined,
        { 'X-Confirm-Clear': 'yes' },
      );
      setConfirmClear(false);
      toast.success(result.message);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not clear the application data.',
      );
    }
  };

  return (
    <>
      <PageIntro />

      <div className="grid grid-cols-1 gap-6">
        <Section
          title="Appearance"
          description="Choose a theme. System follows your operating system setting."
        >
          <fieldset>
            <legend className="sr-only">Theme preference</legend>
            <div className="flex flex-wrap gap-2">
              {THEME_CHOICES.map((choice) => {
                const Icon = choice.icon;
                const active = preference === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => setPreference(choice.value)}
                    aria-pressed={active}
                    className={`btn ${active ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </Section>

        <Section
          title="Browser extension"
          description="The Wheelhouse extension posts the eBay listings on your screen to this address."
        >
          <label className="label" htmlFor="backend-url">
            Wheelhouse backend URL
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="backend-url"
              className="input sm:flex-1"
              value={backendUrl}
              onChange={(event) => setBackendUrl(event.target.value)}
              placeholder={DEFAULT_BACKEND_URL}
              spellCheck={false}
            />
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary" onClick={copyBackendUrl}>
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn btn-primary" onClick={saveBackendUrl}>
                Save
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-md border border-outline-variant bg-background p-3 text-sm text-on-surface-variant">
            <Puzzle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium text-on-surface">
                Loading the extension
              </p>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                <li>Open <code>chrome://extensions</code> in Chrome.</li>
                <li>Turn on Developer mode.</li>
                <li>
                  Choose <em>Load unpacked</em> and select the{' '}
                  <code>wheelhouse/browser-extension</code> folder.
                </li>
                <li>Open the extension and paste the backend URL above into its settings.</li>
              </ol>
            </div>
          </div>
        </Section>

        <Section
          title="Application information"
          description="Where Wheelhouse is running and what it is storing."
        >
          {info.error ? (
            <p className="text-sm text-danger-text">{info.error}</p>
          ) : (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {[
                ['Application', info.data ? `${info.data.name} ${info.data.version}` : '—'],
                ['Tagline', info.data?.tagline ?? '—'],
                ['Node.js', info.data?.node_version ?? '—'],
                ['Database', info.data?.database_path ?? '—'],
                [
                  'Server started',
                  info.data ? formatDateTime(info.data.started_at) : '—',
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-on-surface-muted uppercase">
                    {label === 'Database' ? (
                      <Database className="size-3" aria-hidden="true" />
                    ) : null}
                    {label}
                  </dt>
                  <dd className="mt-1 text-sm break-all text-on-surface">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        <Section
          title="Application data"
          description="Remove every lead, contact, partner, project, event, note and imported eBay listing. Category and status configuration is kept."
        >
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Clear all application data
          </button>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all application data"
        message="This permanently deletes every lead, contact, referral partner, project, event, note and imported eBay listing. This cannot be undone."
        confirmLabel="Delete everything"
        onConfirm={clearAllData}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
