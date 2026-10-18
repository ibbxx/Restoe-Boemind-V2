"use client";

import { useState } from "react";
import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { updateCellInput } from "../domain/commands.ts";
import { addColumn, addRow, addTable, clearCellSource, mergeCells, removeColumn, removeRow, setCellFormula, unmergeCells } from "../domain/structure.ts";
import { SheetEditor } from "./sheet-editor.tsx";

export function WorksheetEditor({ snapshot, run, configuration, disabled, onChange, onError, onEditing, onSave }: {
  snapshot: WorkbookSnapshot; run: EngineRun | null; configuration: EngineConfiguration | null; disabled: boolean;
  onChange: (snapshot: WorkbookSnapshot) => void; onError: (message: string) => void; onEditing: () => void; onSave: () => void;
}) {
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const selectedTable = snapshot.worksheets.flatMap(w => w.tables).find(t => t.cells.some(c => c.id === selectedCellId));
  const selectedCell = selectedTable?.cells.find(c => c.id === selectedCellId);
  const selectedRow = selectedTable?.rows.find(r => r.id === selectedCell?.rowId);
  const selectedColumn = selectedTable?.columns.find(c => c.id === selectedCell?.columnId);
  const selectedMerge = selectedTable?.merges.find(m => m.anchorCellId === selectedCellId);
  function apply(action: () => WorkbookSnapshot) {
    try { onChange(action()); onError(""); } catch (cause) { onError(cause instanceof Error ? cause.message : "Perubahan gagal."); }
  }
  function select(cellId: string) {
    setSelectedCellId(cellId);
    setExpression(snapshot.formulas.find(f => f.targetCellId === cellId)?.expression ?? "");
  }
  function guardRemoval(tableId: string, rowId?: string, columnId?: string) {
    const table = snapshot.worksheets.flatMap(w => w.tables).find(t => t.id === tableId);
    const removed = new Set(table?.cells.filter(c => c.rowId === rowId || c.columnId === columnId).map(c => c.id));
    if (configuration?.aggregates.some(a => a.memberCellIds.some(id => removed.has(id))) || configuration?.selectionDependentCellIds.some(id => removed.has(id))) {
      throw new Error("Sel masih menjadi anggota agregat atau dependensi penawaran. Lepaskan referensinya terlebih dahulu.");
    }
  }
  return <>
    <p className="editor-intro">Pilih sel untuk mengubah formula atau menggabungkan area. Perubahan disimpan sebagai revisi workbook.</p>
    <div className="editor-formula-bar">
      <span className="editor-cell-address">{selectedCell ? `${selectedRow?.label} / ${selectedColumn?.label}` : "Pilih sel pada tabel"}</span>
      <form onSubmit={event => { event.preventDefault(); if (selectedCell) apply(() => setCellFormula(snapshot, selectedCell.id, expression)); }}>
        <label>Formula sel terpilih<input aria-label="Formula sel terpilih" value={expression} onChange={event => setExpression(event.target.value)} placeholder="@{ID sel} * 2" disabled={disabled || !selectedCell} required /></label>
        <button disabled={disabled || !selectedCell}>Atur formula</button>
      </form>
      {selectedCell && <>
        <code className="cell-reference">{`@{${selectedCell.id}}`}</code>
        <div className="editor-actions">
          <button disabled={disabled} onClick={() => setExpression(snapshot.formulas.find(f => f.targetCellId === selectedCell.id)?.expression ?? "")}>Muat formula sel</button>
          <button disabled={disabled} onClick={() => apply(() => clearCellSource(snapshot, selectedCell.id))}>Kosongkan sel</button>
        </div>
        <form className="merge-controls" onSubmit={event => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          if (selectedTable) apply(() => mergeCells(snapshot, selectedTable.id, selectedCell.id, { rowSpan: Number(form.get("rows")), colSpan: Number(form.get("columns")) }));
        }}><label>Span baris<input name="rows" type="number" min="1" step="1" defaultValue="1" required /></label>
          <label>Span kolom<input name="columns" type="number" min="1" step="1" defaultValue="2" required /></label>
          <button disabled={disabled}>Gabung sel</button>
          <button type="button" disabled={disabled || !selectedMerge} onClick={() => { if (selectedTable && selectedMerge) apply(() => unmergeCells(snapshot, selectedTable.id, selectedMerge.id)); }}>Pisah sel</button>
        </form>
      </>}
      {!configuration && <p className="editor-hint">Konfigurasi preview belum tersedia untuk workbook ini.</p>}
    </div>
    <SheetEditor snapshot={snapshot} run={run} disabled={disabled} selectedCellId={selectedCellId} onSelectCell={select} onEditing={onEditing}
      onCellInput={(cell, value) => apply(() => updateCellInput(snapshot, cell.scope, cell.id, value.trim() ? { kind: cell.source.kind === "INPUT" && cell.source.input.kind === "TEXT" ? "TEXT" : "NUMERIC_TEXT", text: value } : { kind: "UNSET" }))}
      onAddRow={(tableId, label, scope) => apply(() => addRow(snapshot, tableId, { label, scope }))}
      onAddColumn={(tableId, label, scope) => apply(() => addColumn(snapshot, tableId, { label, scope }))}
      onRemoveRow={(tableId, rowId) => apply(() => { guardRemoval(tableId, rowId); return removeRow(snapshot, tableId, rowId); })}
      onRemoveColumn={(tableId, columnId) => apply(() => { guardRemoval(tableId, undefined, columnId); return removeColumn(snapshot, tableId, columnId); })} />
    <form className="editor-new-table" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      apply(() => addTable(snapshot, form.get("worksheet"), { label: "Tabel tambahan" }));
    }}><label>Tahap tabel baru<select aria-label="Tahap tabel baru" name="worksheet">{snapshot.worksheets.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}</select></label><button disabled={disabled}>Tambah tabel</button></form>
    <footer className="editor-footer"><span>Profil {snapshot.activeProfile} · Preview nonfinal</span><button disabled={disabled} onClick={onSave}>Simpan perubahan</button></footer>
  </>;
}
