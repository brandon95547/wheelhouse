import { useEffect, useId, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { ApiError } from '../lib/api';

export interface FieldDef {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'tel'
    | 'url'
    | 'date'
    | 'time'
    | 'number'
    | 'textarea'
    | 'select';
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Label for the blank choice on an optional select. */
  emptyLabel?: string;
  placeholder?: string;
  help?: string;
  /** Make the field span the full width of the two-column grid. */
  full?: boolean;
  min?: number;
  rows?: number;
}

type Values = Record<string, string>;

function initialValues(fields: FieldDef[], record?: Record<string, unknown> | null): Values {
  const values: Values = {};
  for (const field of fields) {
    const raw = record?.[field.name];
    let value = raw === null || raw === undefined ? '' : String(raw);
    // A required select renders no blank choice, so the browser displays its
    // first option. Seed the state to match, or the form would report the
    // field as empty while showing a value.
    if (!value && field.type === 'select' && field.required && field.options?.length) {
      value = field.options[0].value;
    }
    values[field.name] = value;
  }
  return values;
}

/**
 * One form component shared by every section. Pages describe their fields and
 * this handles state, required-field checks, server validation errors, the
 * busy state and the button row.
 */
export function RecordForm({
  fields,
  record,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  fields: FieldDef[];
  record?: Record<string, unknown> | null;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [values, setValues] = useState<Values>(() => initialValues(fields, record));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Option lists arrive from the API, so a required select can still be empty
  // when the form first mounts. Fill it in as soon as the options land.
  const optionsKey = JSON.stringify(
    fields.map((field) => [field.name, field.options?.map((option) => option.value)]),
  );
  useEffect(() => {
    setValues((current) => {
      const next = { ...current };
      let changed = false;
      for (const field of fields) {
        if (
          field.type === 'select' &&
          field.required &&
          !next[field.name] &&
          field.options?.length
        ) {
          next[field.name] = field.options[0].value;
          changed = true;
        }
      }
      return changed ? next : current;
    });
    // `fields` is rebuilt each render; optionsKey tracks what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);

  const setValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    // Required fields are checked here as well as on the server, so the user
    // gets the message without a round trip.
    const found: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        found[field.name] = `${field.label} is required`;
      }
    }
    if (Object.keys(found).length) {
      setErrors(found);
      document
        .getElementById(`${formId}-${Object.keys(found)[0]}`)
        ?.focus({ preventScroll: false });
      return;
    }

    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name]?.trim() ?? '';
      if (raw === '') {
        payload[field.name] = null;
      } else if (field.type === 'number') {
        payload[field.name] = Number(raw);
      } else {
        payload[field.name] = raw;
      }
    }

    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length) {
        const mapped: Record<string, string> = {};
        for (const item of error.fieldErrors) mapped[item.field] = item.message;
        setErrors(mapped);
        setFormError('Please correct the highlighted fields.');
      } else {
        setFormError(
          error instanceof ApiError ? error.message : 'Could not save. Please try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="px-5 py-4">
        {formError ? (
          <div
            className="mb-4 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-container px-3 py-2 text-sm text-on-danger-container"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{formError}</span>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fields.map((field) => {
            const id = `${formId}-${field.name}`;
            const error = errors[field.name];
            const describedBy =
              [error ? `${id}-error` : null, field.help ? `${id}-help` : null]
                .filter(Boolean)
                .join(' ') || undefined;
            const shared = {
              id,
              name: field.name,
              value: values[field.name] ?? '',
              'aria-invalid': error ? (true as const) : undefined,
              'aria-describedby': describedBy,
              onChange: (
                event: React.ChangeEvent<
                  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                >,
              ) => setValue(field.name, event.target.value),
            };

            return (
              <div
                key={field.name}
                className={field.full || field.type === 'textarea' ? 'sm:col-span-2' : ''}
              >
                <label className="label" htmlFor={id}>
                  {field.label}
                  {field.required ? (
                    <span className="ml-0.5 text-danger-text" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>

                {field.type === 'textarea' ? (
                  <textarea
                    {...shared}
                    rows={field.rows ?? 4}
                    placeholder={field.placeholder}
                    className={`textarea ${error ? 'input-invalid' : ''}`}
                  />
                ) : field.type === 'select' ? (
                  <select {...shared} className={`select ${error ? 'input-invalid' : ''}`}>
                    {!field.required ? (
                      <option value="">{field.emptyLabel ?? '— None —'}</option>
                    ) : null}
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    {...shared}
                    type={field.type ?? 'text'}
                    min={field.min}
                    placeholder={field.placeholder}
                    className={`input ${error ? 'input-invalid' : ''}`}
                  />
                )}

                {field.help && !error ? (
                  <p id={`${id}-help`} className="mt-1.5 text-xs text-on-surface-muted">
                    {field.help}
                  </p>
                ) : null}
                {error ? (
                  <p id={`${id}-error`} className="field-error">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-outline-variant px-5 py-4">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
