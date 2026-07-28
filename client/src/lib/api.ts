/**
 * Thin fetch wrapper around the Wheelhouse API.
 *
 * Requests go to same-origin `/api/...` — Vite proxies that to the API server
 * in development, and the server serves the built client in production.
 */

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  fieldErrors: FieldError[];

  constructor(status: number, message: string, fieldErrors: FieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

type Query = Record<string, string | number | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Query; headers?: Record<string, string> } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withQuery(`/api${path}`, options.query), {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(
      0,
      'Could not reach the Wheelhouse server. Make sure it is running on port 4000.',
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const data = (payload ?? {}) as {
      error?: string;
      message?: string;
      details?: FieldError[];
    };
    throw new ApiError(
      response.status,
      data.message ?? data.error ?? `Request failed (${response.status})`,
      Array.isArray(data.details) ? data.details : [],
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string, query?: Query, headers?: Record<string, string>) =>
    request<T>('DELETE', path, { query, headers }),
};

export interface ImportSummary {
  found: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: Array<{ index: number; title: string; reason: string }>;
  message: string;
}
