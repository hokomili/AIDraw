import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function EditorDialog({
  title,
  description,
  className = '',
  onClose,
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const surface = surfaceRef.current;
    const initial = surface?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button');
    initial?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(surface?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={surfaceRef} className={`modal-surface editor-entry-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <div><strong id={titleId}>{title}</strong>{description && <p>{description}</p>}</div>
          <button type="button" className="modal-close" title="Close" aria-label="Close dialog" onClick={onClose}><X size={17} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function EntryDialog({
  title,
  description,
  label,
  initialValue,
  submitLabel = 'Apply',
  type = 'text',
  min,
  max,
  maxLength = 500,
  validate,
  preview,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  label: string;
  initialValue: string;
  submitLabel?: string;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  maxLength?: number;
  validate?: (value: string) => string | undefined;
  preview?: (value: string) => ReactNode;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const error = validate?.(value);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (error) return;
    setSubmitting(true);
    try { await onSubmit(value); } finally { setSubmitting(false); }
  };
  return (
    <EditorDialog title={title} description={description} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="entry-dialog-body">
          <label className="dialog-field">
            <span>{label}</span>
            <input autoFocus type={type} min={min} max={max} maxLength={type === 'text' ? maxLength : undefined} value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={Boolean(error)} />
          </label>
          {preview && <div className="entry-dialog-preview">{preview(value)}</div>}
          {error && <p className="entry-dialog-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-modal-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-modal-button" disabled={Boolean(error) || submitting}>{submitting ? 'Applying…' : submitLabel}</button>
        </footer>
      </form>
    </EditorDialog>
  );
}
