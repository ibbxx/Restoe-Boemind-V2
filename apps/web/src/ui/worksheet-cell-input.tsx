"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";

export function WorksheetCellInput({ label, raw, shown, selected, editing, expression, formulaPreview, disabled, needsCommit = false, onFocusInput, onSelect, onDraft, onCommit, onCancel }: {
  label: string; raw: string; shown: string; selected: boolean; editing: boolean; expression: string; disabled: boolean;
  needsCommit?: boolean;
  formulaPreview?: ReactNode;
  onFocusInput: (input: HTMLInputElement) => void;
  onSelect: () => void; onDraft: (value: string) => void; onCommit: (value: string) => boolean; onCancel: () => void;
}) {
  const [focused, setFocused] = useState(false), [invalid, setInvalid] = useState(false);
  const skipBlur = useRef(false);
  const previewRef = useRef<HTMLSpanElement | null>(null);
  const doubleClickCaret = useRef<number | null>(null);
  const showPreview = selected && (focused || editing || invalid) && expression.trimStart().startsWith("=") && !!formulaPreview;
  return <>
    <input className="sheet-input" aria-label={label} aria-invalid={invalid}
      data-token-preview={showPreview ? "true" : undefined}
      data-invalid={invalid ? "true" : "false"} disabled={disabled} inputMode="text"
      value={selected && (focused || editing || invalid) ? expression : shown}
      onFocus={event => {
        onFocusInput(event.currentTarget);
        setFocused(true);
        if (!selected || !editing) {
          onSelect();
        }
      }}
      onPointerDown={event => { if (event.detail === 2) doubleClickCaret.current = event.currentTarget.selectionStart; }}
      onDoubleClick={event => {
        event.preventDefault();
        const caret = doubleClickCaret.current ?? event.currentTarget.selectionEnd ?? 0;
        event.currentTarget.setSelectionRange(caret, caret);
      }}
      onChange={event => { setInvalid(false); onDraft(event.currentTarget.value); }}
      onScroll={event => { if (previewRef.current) previewRef.current.scrollLeft = event.currentTarget.scrollLeft; }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault(); skipBlur.current = true; setInvalid(false); onCancel(); event.currentTarget.blur();
        } else if (event.key === "Enter" || event.key === "Tab") {
          if (event.key === "Enter") event.preventDefault();
          const unchanged = event.currentTarget.value === raw && !needsCommit;
          if (unchanged) onCancel();
          const saved = unchanged || onCommit(event.currentTarget.value);
          setInvalid(!saved);
          if (!saved) event.preventDefault();
          else { skipBlur.current = true; if (event.key === "Enter") event.currentTarget.blur(); }
        }
      }}
      onBlur={event => {
        setFocused(false);
        if (skipBlur.current) { skipBlur.current = false; return; }
        if (event.currentTarget.value.trimStart().startsWith("=") && event.relatedTarget instanceof Element && event.relatedTarget.closest(".formula-bar-form")) return;
        if (event.currentTarget.value !== raw || needsCommit) setInvalid(!onCommit(event.currentTarget.value));
        else onCancel();
      }} />
    {showPreview && <span ref={previewRef} className="cell-formula-preview" aria-hidden="true">{formulaPreview}</span>}
    <span className="cell-print-value">{shown}</span>
  </>;
}
