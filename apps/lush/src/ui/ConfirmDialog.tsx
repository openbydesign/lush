import { useEffect } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  pendingConfirmLabel?: string;
  pending?: boolean;
  danger?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!props.open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.pending) {
        props.onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.open, props.pending, props.onCancel]);

  if (!props.open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.pending) {
          props.onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-2xl"
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-[var(--color-text)]"
        >
          {props.title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[var(--color-muted)]">
          {props.body}
        </p>
        {props.error ? (
          <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {props.error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={props.pending}
            onClick={props.onCancel}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={props.pending}
            onClick={props.onConfirm}
            className={`rounded-md px-3 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
              props.danger
                ? "border border-red-600 bg-red-600 hover:border-red-700 hover:bg-red-700"
                : "border border-[var(--color-brand)] bg-[var(--color-brand)] hover:border-[var(--color-brand-strong)] hover:bg-[var(--color-brand-strong)]"
            }`}
          >
            {props.pending
              ? props.pendingConfirmLabel ?? props.confirmLabel
              : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
