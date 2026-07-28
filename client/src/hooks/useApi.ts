import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';

type Query = Record<string, string | number | undefined | null>;

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Loads a GET endpoint and re-runs whenever the path or query changes.
 * Out-of-order responses are discarded so fast typing in a search box cannot
 * leave stale results on screen.
 */
export function useApi<T>(path: string, query?: Query): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  const queryKey = JSON.stringify(query ?? {});

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);

    api
      .get<T>(path, JSON.parse(queryKey) as Query)
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        setError(
          err instanceof ApiError ? err.message : 'Something went wrong loading data.',
        );
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [path, queryKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}

/** Delays a rapidly-changing value, used to keep search from firing per keystroke. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
