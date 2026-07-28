import { badRequest } from './errors.js';

/**
 * A small hand-rolled validator. Each field spec describes one column; the
 * validator turns an arbitrary request body into a clean row object and
 * collects every problem it finds so the client gets one useful error message
 * instead of a stream of them.
 */

export type FieldType = 'string' | 'number' | 'integer' | 'date' | 'time';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Restrict to a fixed set of values. */
  oneOf?: readonly string[];
  /** Value used when the field is absent on create. */
  default?: string | number | null;
}

export type Schema = Record<string, FieldSpec>;

export interface FieldError {
  field: string;
  message: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function coerce(
  field: string,
  spec: FieldSpec,
  raw: unknown,
  errors: FieldError[],
): unknown {
  // Empty strings and null both mean "no value" for optional fields.
  if (raw === null || raw === undefined || raw === '') {
    if (spec.required) {
      errors.push({ field, message: `${field} is required` });
      return undefined;
    }
    return null;
  }

  switch (spec.type) {
    case 'string': {
      const value = typeof raw === 'string' ? raw.trim() : String(raw).trim();
      if (!value) {
        if (spec.required) {
          errors.push({ field, message: `${field} is required` });
          return undefined;
        }
        return null;
      }
      if (spec.maxLength && value.length > spec.maxLength) {
        errors.push({
          field,
          message: `${field} must be ${spec.maxLength} characters or fewer`,
        });
        return undefined;
      }
      if (spec.oneOf && !spec.oneOf.includes(value)) {
        errors.push({
          field,
          message: `${field} must be one of: ${spec.oneOf.join(', ')}`,
        });
        return undefined;
      }
      return value;
    }

    case 'number':
    case 'integer': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) {
        errors.push({ field, message: `${field} must be a number` });
        return undefined;
      }
      if (spec.type === 'integer' && !Number.isInteger(value)) {
        errors.push({ field, message: `${field} must be a whole number` });
        return undefined;
      }
      if (spec.min !== undefined && value < spec.min) {
        errors.push({ field, message: `${field} must be at least ${spec.min}` });
        return undefined;
      }
      if (spec.max !== undefined && value > spec.max) {
        errors.push({ field, message: `${field} must be at most ${spec.max}` });
        return undefined;
      }
      return value;
    }

    case 'date': {
      const value = String(raw).trim().slice(0, 10);
      if (!isRealDate(value)) {
        errors.push({ field, message: `${field} must be a date (YYYY-MM-DD)` });
        return undefined;
      }
      return value;
    }

    case 'time': {
      const value = String(raw).trim().slice(0, 5);
      if (!TIME_RE.test(value)) {
        errors.push({ field, message: `${field} must be a time (HH:MM)` });
        return undefined;
      }
      return value;
    }
  }
}

/** Validates a create request. Every schema key is present in the result. */
export function validateCreate(
  body: unknown,
  schema: Schema,
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  const row: Record<string, unknown> = {};

  for (const [field, spec] of Object.entries(schema)) {
    const raw = input[field] ?? (spec.default !== undefined ? spec.default : undefined);
    row[field] = coerce(field, spec, raw, errors);
  }

  if (errors.length) throw badRequest('Validation failed', errors);
  return row;
}

/**
 * Validates a partial update. Only keys actually present in the body are
 * returned, so a PATCH never blanks out fields the client did not send.
 */
export function validatePatch(
  body: unknown,
  schema: Schema,
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  const row: Record<string, unknown> = {};

  for (const [field, spec] of Object.entries(schema)) {
    if (!(field in input)) continue;
    row[field] = coerce(field, spec, input[field], errors);
  }

  if (errors.length) throw badRequest('Validation failed', errors);
  if (!Object.keys(row).length) {
    throw badRequest(
      `No updatable fields provided. Allowed fields: ${Object.keys(schema).join(', ')}`,
    );
  }
  return row;
}

/** Parses a numeric :id route parameter. */
export function parseId(raw: string | undefined, label = 'id'): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`Invalid ${label}: expected a positive integer`);
  }
  return id;
}
