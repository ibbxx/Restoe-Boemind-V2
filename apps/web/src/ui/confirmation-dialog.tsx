import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

export function ConfirmationDialog({ eyebrow, title, description, confirmLabel = "Lanjutkan", cancelLabel = "Batal", secondaryLabel, onSecondary, onConfirm, onCancel }: {
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  onSecondary?: () => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [running, setRunning] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), cancelButton = useRef<HTMLButtonElement | null>(null), dialog = useRef<HTMLElement | null>(null);
  useEffect(() => { const previous = document.activeElement; cancelButton.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { if (!running) cancelButton.current?.focus(); }, [running]);
  async function act(action: () => void | Promise<void>) {
    if (pending.current) return;
    pending.current = true; dialog.current?.focus(); setRunning(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Tindakan gagal. Silakan coba lagi."); }
    finally { pending.current = false; setRunning(false); }
  }
  return <div className="analysis-delete-overlay" role="presentation" onClick={() => { if (!pending.current) onCancel(); }}>
    <section ref={dialog} tabIndex={-1} className="analysis-delete-dialog analysis-confirmation-dialog" role="alertdialog" aria-modal="true" aria-busy={running} aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-description" onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); if (!pending.current) onCancel(); }
      if (event.key === "Tab") {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0]!, last = buttons.at(-1)!;
        if (!buttons.some(button => button === document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <div className="analysis-delete-icon" aria-hidden="true"><AlertTriangle /></div>
      <div className="analysis-delete-content">
        <p className="analysis-delete-eyebrow">{eyebrow}</p>
        <h2 id="confirmation-dialog-title">{title}</h2>
        <p id="confirmation-dialog-description">{description}</p>
        {error && <p role="alert">{error}</p>}
        <div className="analysis-delete-actions">
          <button ref={cancelButton} type="button" className="analysis-delete-cancel" disabled={running} onClick={onCancel}>{cancelLabel}</button>
          {secondaryLabel && onSecondary && <button type="button" className="analysis-delete-cancel" disabled={running} onClick={() => void act(onSecondary)}>{secondaryLabel}</button>}
          <button type="button" className="analysis-delete-confirm" disabled={running} onClick={() => void act(onConfirm)}>{running ? "Memproses…" : confirmLabel}</button>
        </div>
      </div>
    </section>
  </div>;
}
