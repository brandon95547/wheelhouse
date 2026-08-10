import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './Modal';

/** Confirmation step shown before anything destructive happens. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      title={title}
      size="sm"
    >
      <div className="px-5 py-4">
        <p className="text-sm text-on-surface-variant">{message}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-outline-variant px-5 py-4">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`}
          onClick={run}
          disabled={busy}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
