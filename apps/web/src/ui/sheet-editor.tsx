"use client";

import { useState } from "react";
import type { CellSnapshot, WorkbookSnapshot } from "../domain/contracts.ts";
import type { Profile } from "../domain/profiles.ts";
import type { EngineRun } from "../engine/contracts.ts";
import { buildSheetGrid, sheetNumber } from "./sheet-grid.ts";

interface SheetEditorProps {
  snapshot: WorkbookSnapshot;
  run: EngineRun | null;
  disabled: boolean;
  selectedCellId: string | null;
  onSelectCell: (cellId: string) => void;
  onCellInput: (cell: CellSnapshot, value: string) => void;
  onEditing: () => void;
  onAddRow: (tableId: string, label: string, scope: Profile | "SHARED") => void;
  onAddColumn: (tableId: string, label: string, scope: Profile | "SHARED") => void;
  onRemoveRow: (tableId: string, rowId: string) => void;
  onRemoveColumn: (tableId: string, columnId: string) => void;
}

// Every value shown here comes from the engine run or the raw stored input; this component never computes money.
function readout(cell: CellSnapshot, run: EngineRun | null): string {
  const result = run?.results.find(entry => entry.cellId === cell.id);
  if (result) return "value" in result ? sheetNumber(result.value) : "text" in result ? result.text : result.status;
  if (cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET")
    return cell.source.input.kind === "NUMERIC_TEXT" ? sheetNumber(cell.source.input.text) : cell.source.input.text;
  return "—";
}

function rawInput(cell: CellSnapshot): string {
  return cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
}

export function SheetEditor(props: SheetEditorProps) {
  const { snapshot, run, disabled, selectedCellId } = props;
  const [labels, setLabels] = useState<Record<string, string>>({});
  const setLabel = (tableId: string, value: string) => setLabels(current => ({ ...current, [tableId]: value }));
  return <section className="sheet-editor" aria-label="Editor tabel dinamis">
    {snapshot.worksheets.map(worksheet => worksheet.tables.length === 0 ? null : <div key={worksheet.id} className="sheet-editor-stage">
      <h3>{worksheet.label}</h3>
      {worksheet.tables.filter(table => !table.cells.length || table.cells.some(c => c.scope === "SHARED" || c.scope === snapshot.activeProfile)).map((table, tableIndex) => {
        const grid = buildSheetGrid(table);
        const label = labels[table.id] ?? "";
        return <article key={table.id} className="sheet-editor-table">
          <div className="sheet-editor-controls"><strong>Tabel {tableIndex + 1}</strong>
            <input aria-label={"Label baru pada " + worksheet.label} placeholder="label baris/kolom baru" value={label}
              disabled={disabled} onChange={event => setLabel(table.id, event.target.value)} />
            <button type="button" disabled={disabled} title="Tambah baris pada tabel ini" onClick={() => {
              props.onAddRow(table.id, label.trim() || "Baris baru " + (table.rowOrder.length + 1), snapshot.activeProfile); setLabel(table.id, "");
            }}>+ Baris</button>
            <button type="button" disabled={disabled} title="Tambah kolom pada tabel ini" onClick={() => {
              props.onAddColumn(table.id, label.trim() || "Kolom baru " + (table.columnOrder.length + 1), snapshot.activeProfile); setLabel(table.id, "");
            }}>+ Kolom</button>
          </div>
          <table className="sheet-editor-grid">
            <thead><tr><th scope="col" />{table.columnOrder.map(columnId => { const column = table.columns.find(c => c.id === columnId)!; return <th scope="col" key={column.id}>
              {column.label}
              <button type="button" className="cell-action" aria-label={"Hapus kolom " + column.label} disabled={disabled}
                onClick={() => props.onRemoveColumn(table.id, column.id)}>×</button>
            </th>; })}</tr></thead>
            <tbody>
              {grid.map((row, index) => {
                const rowId = table.rowOrder[index]!;
                const rowLabel = table.rows.find(entry => entry.id === rowId)?.label ?? rowId;
                return <tr key={rowId}>
                  <th scope="row">{rowLabel}
                    <button type="button" className="cell-action" aria-label={"Hapus baris " + rowLabel} disabled={disabled}
                      onClick={() => props.onRemoveRow(table.id, rowId)}>×</button>
                  </th>
                  {row.map((entry, columnIndex) => {
                    if (entry === null) return null;
                    if (!entry.cell) return <td key={columnIndex} className="structural-gap" />;
                    const cell = entry.cell;
                    const active = cell.scope === "SHARED" || cell.scope === snapshot.activeProfile;
                    const pinned = snapshot.mappings.some(m => m.sourceCellId === cell.id && m.sourceComponent.startsWith("offer-value:"));
                    return <td key={cell.id} rowSpan={entry.rowSpan} colSpan={entry.colSpan} onClick={() => props.onSelectCell(cell.id)}
                      className={selectedCellId === cell.id ? "cell-selected" : undefined}>
                      {active && cell.source.kind === "INPUT" && !pinned
                        ? <input key={cell.id + ":" + rawInput(cell)} className="sheet-input" aria-label={"Sel " + cell.id} defaultValue={rawInput(cell)} disabled={disabled}
                            data-zero={cell.source.input.kind === "NUMERIC_TEXT" && sheetNumber(rawInput(cell)) === "" && rawInput(cell) !== ""}
                            onFocus={() => props.onSelectCell(cell.id)}
                            onChange={props.onEditing}
                            onBlur={event => {
                              if (event.target.value !== rawInput(cell)) props.onCellInput(cell, event.target.value);
                            }} />
                        : <button type="button" className="cell-readout" disabled={disabled || !active} onClick={() => props.onSelectCell(cell.id)}>{active ? readout(cell, run) : "Profil lain"}</button>}
                    </td>;
                  })}
                </tr>;
              })}
            </tbody>
          </table>
        </article>;
      })}
    </div>)}
  </section>;
}
