"use client";

import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, FileSpreadsheet, Link2, Printer, Save, Search, X } from "lucide-react";
import type { AhsSection, CellSnapshot, WorkbookSnapshot } from "../domain/contracts.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { externalAddresses, addExternalAhsItem, addExternalAhsField } from "../domain/external-ahs.ts";
import { canvasCellAddresses } from "../domain/canvas-address.ts";
import { describeCell, displayFormula, resolveFormula } from "../domain/cell-address.ts";
import { numericInput } from "../domain/numeric-input.ts";
import { setCellFormula, setCellInput } from "../domain/structure.ts";
import { buildSheetGrid, sheetNumber, visibleSheetTable } from "./sheet-grid.ts";
import { WorksheetCellInput } from "./worksheet-cell-input.tsx";
import { AhsActions } from "./ahs-actions.tsx";
import { printWorkbook, workbookPrintTitle } from "./print-workbook.ts";

interface Props {
  snapshot: WorkbookSnapshot;
  configuration: EngineConfiguration;
  run: EngineRun | null;
  notice: string;
  disabled: boolean;
  saving: boolean;
  calculating: boolean;
  onChange: (snapshot: WorkbookSnapshot, configuration?: EngineConfiguration) => void;
  onSave: () => void;
  onEditing: () => void;
  onPrintLoading: (loading: boolean) => void;
}
export function ExternalAhsSurface({ snapshot, configuration, run, notice, disabled, saving, calculating, onChange, onSave, onEditing, onPrintLoading }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [expression, setExpression] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const activeInput = useRef<HTMLInputElement | null>(null);
  const sourceDialog = useRef<HTMLDialogElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const results = new Map<string, NonNullable<EngineRun["provisional"]>["results"][number]>((run?.provisional?.results ?? run?.results ?? []).map(r => [r.cellId, r]));
  const tables = snapshot.worksheets.find(w => w.stage === "AHS_EXTERNAL")?.tables.filter(t => t.cells.some(c => c.scope === snapshot.activeProfile)).map(table => visibleSheetTable(table,
    new Set(table.rows.filter(row => row.label.split("|")[2] === "external-hidden").map(row => row.id)))) ?? [];
  const cells = tables.flatMap(t => t.cells);
  const target = cells.find(c => c.id === selected);
  const addresses = externalAddresses(snapshot);
  const internalAddresses = canvasCellAddresses(snapshot);
  const presentations = new Map(snapshot.externalAhs?.cells.map(p => [p.cellId, p]));
  const groupLabelIds = new Set(snapshot.externalAhs?.groups.filter(group => group.profile === snapshot.activeProfile).flatMap(group => group.labelCellId ? [group.labelCellId] : []));
  const sources = useMemo(() => snapshot.worksheets.filter(w => w.stage !== "AHS_EXTERNAL").flatMap(w => w.tables.flatMap(t => t.cells)).filter(c => c.scope === "SHARED" || c.scope === snapshot.activeProfile).map(cell => ({ cell, label: describeCell(cell.id, snapshot) })), [snapshot]);
  const value = (cell: CellSnapshot) => {
    const result = results.get(cell.id);
    if (result?.status === "VALUE" || result?.status === "ZERO") return sheetNumber(result.value);
    if (result?.status === "TEXT") return result.text;
    if (result && "code" in result && result.status !== "EMPTY") return `#${result.code}`;
    return cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.kind === "TEXT" ? cell.source.input.text : sheetNumber(cell.source.input.text) : "";
  };
  const raw = (cell: CellSnapshot) => cell.source.kind === "FORMULA" ? "=" + displayFormula(snapshot.formulas.find(f => f.targetCellId === cell.id)!.expression, snapshot, cell.id) : cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
  function apply(action: () => void) { try { action(); setError(""); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : "Input tidak valid."); return false; } }
  function select(cell: CellSnapshot) { setSelected(cell.id); setExpression(raw(cell)); setEditing(false); }
  function commit(cell: CellSnapshot, text: string): boolean {
    return apply(() => {
      const content = text.trim(), numeric = numericInput(content);
      const meta = presentations.get(cell.id);
      const isNumeric = meta?.unit !== "text" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric);
      if (content && !content.startsWith("=") && meta?.unit !== "text" && !isNumeric) throw new Error("Sel angka wajib diisi angka atau rumus.");
      const next = content.startsWith("=") ? setCellFormula(snapshot, cell.id, resolveFormula(content.slice(1), snapshot, cell.id)) : setCellInput(snapshot, cell.id, content ? { kind: isNumeric ? "NUMERIC_TEXT" : "TEXT", text: isNumeric ? numeric : content } : { kind: "UNSET" });
      onChange(next); setEditing(false); setExpression(content);
    });
  }
  function appendReference(id: string, internal = false) {
    const code = internal ? `INTERNAL!${internalAddresses.get(id)}` : addresses.get(id);
    if (!code) return;
    const input = activeInput.current, caret = input?.selectionStart ?? expression.length, end = input?.selectionEnd ?? caret;
    const next = expression.slice(0, caret) + code + expression.slice(end);
    setExpression(next); setEditing(true); onEditing();
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(caret + code.length, caret + code.length); });
  }
  function applyFormula(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.currentTarget.dataset.commitFailed = target && commit(target, expression) ? "false" : "true";
  }
  async function print() {
    if (!sheetRef.current || calculating || printing) return;
    const sheet = sheetRef.current;
    if (editing && target && !commit(target, expression)) return;
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    if (sheet.querySelector('[data-invalid="true"]')) return;
    setPrinting(true); onPrintLoading(true);
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      while (sheet.dataset.calculating === "true") { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (sheetRef.current !== sheet) return; }
      await printWorkbook(sheet, [], workbookPrintTitle({ projectName: snapshot.project.name, analysisName: snapshot.analysis.analysis.name + " - Eksternal", volume: "", material: "" }), "EXTERNAL");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Cetak gagal."); }
    finally { setPrinting(false); onPrintLoading(false); }
  }
  function beforeAdd() {
    if (editing && target && !commit(target, expression)) return false;
    if (sheetRef.current?.querySelector('[data-invalid="true"]')) { setError("Perbaiki input sel sebelum menambah uraian."); return false; }
    setError(""); return true;
  }
  function addEntry(section: AhsSection, groupId: string | null, groupName: string, itemName: string) {
    return apply(() => {
      const added = section === "INFORMASI" || section === "LABA" ? addExternalAhsField(snapshot, configuration, section, itemName)
        : addExternalAhsItem(snapshot, configuration, itemName, section, groupId, groupName);
      onChange(added.snapshot, added.configuration); setSelected(added.firstCellId); setExpression(itemName.trim()); setEditing(false);
    });
  }
  const selectedResult = selected && results.get(selected);
  const cellEditor = (cell: CellSnapshot) => <span className="sheet-cell"><WorksheetCellInput label={`AHS Eksternal · ${addresses.get(cell.id)}`} raw={raw(cell)} shown={value(cell)} selected={selected === cell.id} editing={editing} expression={expression} disabled={disabled} onFocusInput={input => { activeInput.current = input; }} onSelect={() => select(cell)} onDraft={text => { setExpression(text); setEditing(true); onEditing(); }} onCommit={text => sourceDialog.current?.open ? true : commit(cell, text)} onCancel={() => { if (sourceDialog.current?.open) return; setExpression(raw(cell)); setEditing(false); }} /></span>;
  return <div className="sheet-viewport external-viewport" aria-label="Worksheet Eksternal">
    <div ref={sheetRef} className="procurement-sheet external-procurement-sheet" data-testid="procurement-sheet" data-calculating={calculating}>
      <header className="sheet-overview external-overview">
        <div className="external-heading">
          <p className="eyebrow"><FileSpreadsheet aria-hidden="true" /> AHS EKSTERNAL</p>
          <h2>{snapshot.analysis.analysis.name}</h2>
          <p>{snapshot.project.name}</p>
        </div>
        <div className="external-header-actions">
          {tables.length > 0 && <>
            <button className="print-button" type="button" aria-label="Cetak AHS Eksternal" title={printing ? "Menyiapkan cetakan…" : "Cetak AHS Eksternal"} disabled={disabled || calculating || printing} onClick={() => void print()}><Printer aria-hidden="true" /></button>
            <button className="external-save" type="button" aria-busy={saving} disabled={disabled || saving} onClick={onSave}><Save aria-hidden="true" />{saving ? "Menyimpan…" : "Simpan perubahan"}</button>
          </>}
        </div>
      </header>
      {notice && <p className="external-notice" role="status">{notice}</p>}
      {error && <p role="alert" className="external-error">{error}</p>}
      {!tables.length ? <div className="external-empty">
        <span className="external-empty-icon"><FileSpreadsheet aria-hidden="true" /></span>
        <h3>AHS Eksternal belum tersedia</h3>
        <p>Kembali ke Internal lalu pilih Eksternal untuk mencoba menyiapkan salinan kembali.</p>
      </div> : <>
        <div className="sheet-canvas-toolbar external-toolbar">
          <div className="toolbar-row formula-row">
            <span className="editor-cell-address" aria-label="Alamat sel Eksternal">{selected ? addresses.get(selected) : "—"}</span>
            <form className="formula-bar-form" onSubmit={applyFormula}>
              <span className="formula-input-wrap external-formula-input">
                <span className="external-formula-symbol" aria-hidden="true">ƒx</span>
                <input aria-label="Formula sel Eksternal" value={expression} data-editing={editing} disabled={disabled || !target} onFocus={e => { activeInput.current = e.currentTarget; }} onChange={e => { setExpression(e.target.value); setEditing(true); onEditing(); }} placeholder={target ? "Ketik nilai atau rumus" : "Pilih sel untuk mengedit nilai atau rumus"} />
              </span>
              {editing && <button type="button" className="external-cancel" aria-label="Batal edit" title="Batal edit" onClick={() => { setEditing(false); setExpression(target ? raw(target) : ""); }}><X aria-hidden="true" /></button>}
              <button type="submit" className="toolbar-button-primary" disabled={disabled || !target}><Check aria-hidden="true" /><span>Terapkan</span></button>
            </form>
          </div>
          <div className="external-toolbar-footer">
            <p>Klik sel untuk mengedit. Gunakan referensi untuk mengambil nilai Internal.</p>
            <div className="external-table-actions">
              <button type="button" disabled={disabled || !target} onClick={() => { if (!expression.startsWith("=")) setExpression("="); setEditing(true); setSourceSearch(""); setSourceOpen(true); sourceDialog.current?.showModal(); }}><Link2 aria-hidden="true" />Referensi Internal</button>
            </div>
          </div>
          {selectedResult && "code" in selectedResult && <p className="toolbar-error" role="status">{selectedResult.code}</p>}
        </div>
        <section className="sheet-card ahs-card" aria-label="AHS Eksternal">{tables.map(table => {
          const notesRows = table.rowOrder.filter(rowId => table.rows.find(row => row.id === rowId)?.label.split("|")[2] === "ahs-notes");
          const noteLabel = table.cells.find(cell => cell.rowId === notesRows[0] && cell.columnId === table.columnOrder[0]);
          const noteValue = table.cells.find(cell => cell.rowId === (notesRows[1] ?? notesRows[0]) && cell.columnId === table.columnOrder[notesRows.length > 1 ? 0 : 5]);
          return <div className="sheet-table-scroll" key={table.id}><table className="ahs-sheet" aria-label="Analisis Harga Satuan AHS">
            <colgroup>{table.columnOrder.map(columnId => <col key={columnId} />)}</colgroup>
            <tbody>{buildSheetGrid(table).map((row, ri) => {
              const rowId = table.rowOrder[ri]!;
              const rowMeta = table.rows.find(r => r.id === rowId)!;
              const storedClass = rowMeta.label.split("|")[2] ?? "";
              const rowClass = snapshot.workbook ? storedClass : storedClass.replace(/\s(?:cost-total|income-total)\b/g, "");
              if (notesRows.includes(rowId)) return rowId === notesRows[0] ? <tr key={rowId} className="ahs-notes"><td colSpan={6}>{noteLabel && cellEditor(noteLabel)}{noteValue && cellEditor(noteValue)}</td></tr> : null;
              return <tr key={rowId} className={`${rowClass}${rowMeta.label.endsWith("|HARGA INCLUDE") ? " ahs-include" : ""}`}>{row.map((entry, ci) => {
                if (!entry) return null;
                const cell = entry.cell;
                if (!cell) return <td key={ci} />;
                const meta = presentations.get(cell.id);
                const isGroupLabel = groupLabelIds.has(cell.id);
                const currency = rowClass.includes("cost-row") && (ci === 2 || (!snapshot.workbook && ci === 4));
                const CellTag = isGroupLabel || ci === 0 || (snapshot.workbook && ci === 1) || rowClass === "ahs-title" ? "th" : "td";
                return <CellTag key={cell.id} colSpan={entry.colSpan} rowSpan={entry.rowSpan} style={{ textAlign: isGroupLabel ? undefined : meta?.align, fontWeight: meta?.bold ? 600 : undefined }} data-cell-id={cell.id} className={[selected === cell.id && "cell-selected", isGroupLabel && "category", ci === 1 && "cost-description", currency && "currency-cell"].filter(Boolean).join(" ") || undefined} onPointerDownCapture={event => {
                  if (event.target instanceof Element && event.target.closest(".vendor-table-actions, .ahs-dialog")) return;
                  if (selected !== cell.id && editing && expression.startsWith("=")) { event.preventDefault(); appendReference(cell.id); }
                }}>
                  {rowClass === "ahs-title" && ci === 0 ? <div className="vendor-title-layout"><div className="vendor-title-content">{cellEditor(cell)}</div>
                    <AhsActions view="EXTERNAL" snapshot={snapshot} section="INFORMASI" sections={["INFORMASI", "PENDAPATAN", "BIAYA", "LABA"]} configuration={configuration}
                      results={run?.provisional?.results ?? run?.results ?? []} disabled={disabled} error={error} onBeforeOpen={beforeAdd} onAdd={addEntry} addButtonRef={addButtonRef} />
                  </div> : <>{currency && <span>Rp</span>}{cellEditor(cell)}</>}
                </CellTag>;
              })}</tr>;
            })}</tbody>
          </table></div>;
        })}</section>
      </>}
    </div>
    <dialog ref={sourceDialog} onClose={() => setSourceOpen(false)} className="vendor-delete-dialog external-dialog external-source-dialog" aria-labelledby="external-source-title">
      <header><div><h2 id="external-source-title">Pilih sel Internal</h2><p>Nilai akan mengikuti perubahan sel sumber pada profil yang sama.</p></div><button type="button" className="dialog-close" aria-label="Tutup" onClick={() => sourceDialog.current?.close()}><X aria-hidden="true" /></button></header>
      <label className="external-source-search"><Search aria-hidden="true" /><input aria-label="Cari sel Internal" value={sourceSearch} onChange={e => setSourceSearch(e.target.value)} placeholder="Cari uraian atau alamat sel…" /></label>
      <div className="external-source-columns" aria-hidden="true"><span>Sel</span><span>Uraian</span><span>Nilai</span></div>
      <div className="external-source-list">{sourceOpen && sources.filter(({ cell, label }) => `${internalAddresses.get(cell.id)} ${label}`.toLowerCase().includes(sourceSearch.toLowerCase())).map(({ cell, label }) => <button type="button" key={cell.id} onClick={() => { sourceDialog.current?.close(); appendReference(cell.id, true); }}><strong>{internalAddresses.get(cell.id)}</strong><span>{label}</span><span>{value(cell)}</span></button>)}</div>
    </dialog>
  </div>;
}
