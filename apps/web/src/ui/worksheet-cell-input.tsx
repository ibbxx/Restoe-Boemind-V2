"use client";

import { useRef, useState } from "react";

export function WorksheetCellInput({ label, raw, shown, selected, editing, expression, disabled, needsCommit = false, onFocusInput, onSelect, onDraft, onCommit, onCancel }: {
  label: string; raw: string; shown: string; selected: boolean; editing: boolean; expression: string; disabled: boolean;
  needsCommit?: boolean;
  onFocusInput: (input: HTMLInputElement) => void;
  onSelect: () => void; onDraft: (value: string) => void; onCommit: (value: string) => boolean; onCancel: () => void;
}) {
  const [focused, setFocused] = useState(false), [invalid, setInvalid] = useState(false);
  const skipBlur = useRef(false);
  return <>
    <input className="sheet-input" aria-label={label} aria-invalid={invalid}
      data-invalid={invalid ? "true" : "false"} disabled={disabled} inputMode="text"
      value={selected && (focused || editing || invalid) ? expression : shown}
      onFocus={event => {
        onFocusInput(event.currentTarget);
        setFocused(true);
        if (!selected || !editing) {
          onSelect();
          const input = event.currentTarget;
          requestAnimationFrame(() => { if (document.activeElement === input) input.select(); });
        }
      }}
      onChange={event => { setInvalid(false); onDraft(event.currentTarget.value); }}
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
      }} />
    <span className="cell-print-value">{shown}</span>
  </>;
}
