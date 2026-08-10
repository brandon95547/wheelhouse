import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Built on the native <dialog> element, which gives us the focus trap, Escape
 * handling, inertness of the page behind, and correct ARIA semantics for free.
 *
 * A page usually has several modals mounted at once (add/edit, plus each
 * confirmation), so the heading id is generated per instance rather than
 * hard-coded.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const widths = {
    sm: 'sm:max-w-md',
    md: 'sm:max-w-2xl',
    lg: 'sm:max-w-4xl',
  } as const;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        // Clicks landing on the dialog itself are backdrop clicks; the content
        // wrapper below stops propagation for everything inside it.
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-full bg-transparent p-3 backdrop:bg-scrim/60"
    >
      <div
        className={`mx-auto flex max-h-[calc(100dvh-1.5rem)] w-full flex-col rounded-lg border border-outline-variant bg-surface text-left shadow-xl ${widths[size]}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-outline-variant px-5 py-4">
          <div>
            <h2
              id={titleId}
              className="text-base font-semibold text-on-surface"
            >
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-on-surface-variant">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon -m-1"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </dialog>
  );
}
