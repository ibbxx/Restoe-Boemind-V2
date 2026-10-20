import { AlertTriangle } from "lucide-react";

export function ConfirmationDialog({ eyebrow, title, description, confirmLabel = "Lanjutkan", onConfirm, onCancel }: {
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <div className="analysis-delete-overlay" role="presentation" onClick={onCancel}>
    <section className="analysis-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-description" onClick={event => event.stopPropagation()}>
      <div className="analysis-delete-icon" aria-hidden="true"><AlertTriangle /></div>
      <div className="analysis-delete-content">
        <p className="analysis-delete-eyebrow">{eyebrow}</p>
        <h2 id="confirmation-dialog-title">{title}</h2>
        <p id="confirmation-dialog-description">{description}</p>
        <div className="analysis-delete-actions">
          <button type="button" className="analysis-delete-cancel" onClick={onCancel}>Batal</button>
          <button type="button" className="analysis-delete-confirm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </section>
  </div>;
}
