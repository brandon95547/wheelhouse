import { useCallback, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useApi } from './useApi';
import { useToast } from './useToast';

type Query = Record<string, string | number | undefined | null>;

/**
 * Shared plumbing for the list pages: loading the collection, the add/edit
 * dialog, the delete confirmation and the success/error messages that go with
 * each. Pages supply the table and the form fields.
 */
export function useCrudPage<T extends { id: number }>(
  basePath: string,
  noun: string,
  query?: Query,
) {
  const { data, loading, error, reload } = useApi<T[]>(basePath, query);
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [deleting, setDeleting] = useState<T | null>(null);

  const openCreate = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((record: T) => {
    setEditing(record);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => setFormOpen(false), []);

  /** Throws on validation failure so the form can show per-field errors. */
  const save = useCallback(
    async (values: Record<string, unknown>) => {
      if (editing) {
        await api.patch(`${basePath}/${editing.id}`, values);
      } else {
        await api.post(basePath, values);
      }
      setFormOpen(false);
      reload();
      toast.success(editing ? `${noun} updated.` : `${noun} added.`);
    },
    [basePath, editing, noun, reload, toast],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await api.delete(`${basePath}/${deleting.id}`);
      setDeleting(null);
      reload();
      toast.success(`${noun} deleted.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Could not delete this ${noun.toLowerCase()}.`);
    }
  }, [basePath, deleting, noun, reload, toast]);

  return {
    rows: data ?? [],
    loading,
    error,
    reload,
    formOpen,
    editing,
    openCreate,
    openEdit,
    closeForm,
    save,
    deleting,
    requestDelete: setDeleting,
    cancelDelete: () => setDeleting(null),
    confirmDelete,
  };
}
