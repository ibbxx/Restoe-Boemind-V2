"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import type { CellSnapshot, TableSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "../domain/contracts.ts";
import type { Profile } from "../domain/profiles.ts";
import type { StableId } from "../domain/ids.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import type { EngineRun } from "../engine/contracts.ts";
import type { StoredRevision } from "../persistence/contracts.ts";
import { buildSheetGrid, sheetNumber, sheetNumberFixed, sheetPercent } from "./sheet-grid.ts";
import { addColumn, addRow, clearCellSource, mergeCells, removeColumn, removeRow, setCellFormula, unmergeCells } from "../domain/structure.ts";
import { addSheetVendor, changeSheetProfile, editSheetInput, removeSheetVendor, resizeSheet, selectSheetOffer } from "../domain/dynamic-workflow.ts";
import { updateCellInput } from "../domain/commands.ts";
import { binding } from "../domain/procurement-template.ts";
import { addOffer, addVendor } from "../domain/commands.ts";
import { appendField } from "../domain/workflow.ts";
import { cellCodes, describeFormula, displayCellId, displayFormula, resolveFormula } from "../domain/cell-address.ts";
import { vendorColumn } from "../domain/legacy-sheet.ts";
import { numericInput } from "./numeric-input.ts";
import { WorksheetCellInput } from "./worksheet-cell-input.tsx";

type Stage = WorksheetSnapshot["stage"];

interface SurfaceProps {
  snapshot: WorkbookSnapshot | null;
  run: EngineRun | null;
  disabled: boolean;
  actor?: StableId<"user"> | null;
  history?: readonly StoredRevision[];
  onChange?: (next: WorkbookSnapshot) => void;
  onError?: (error: string) => void;
  onEditing?: () => void;
  onSave?: () => void;
  onInput?: (stage: Stage, label: string, value: string, kind: "TEXT" | "NUMERIC_TEXT", cell: CellSnapshot | undefined) => void;
  onSelectOffer?: (revisionId: string) => void;
}

const vendorRows = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "BPH"];
const conversionRows = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN", "BPH", "ALL IN"];
const costGroups = [
  { label: "HPP", rows: ["Harga Dasar", "OAT", "PBBKB", "PPH INU 0,3%", "BPH Migas 0,25%"] },
  { label: "PAJAK", rows: ["PPN 11%", "PPH penjualan"] },
  { label: "COST OF FUND", rows: ["Investor", "Bunga Bank", "Diskonto SKBDN"] },
  { label: "OPERASIONAL", rows: ["Biaya Operasional", "Bonus Marketing"] },
  { label: "ASET", rows: ["Tangki Solar"] },
  { label: "KOORDINASI", rows: ["Ormas/Lainnya"] },
  { label: "RELASI", rows: ["Biaya Proyek", "Biaya Mediator"] },
  { label: "RESIKO", rows: ["Biaya Resiko", "Kenaikan Harga"] },
];
const summaryRows = ["LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE"];
const normalized = (text: string) => text.trim().toLocaleLowerCase("id-ID");
const numericText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function WorksheetSurface(props: SurfaceProps) {
  const { snapshot, run, disabled, actor, history, onChange, onError, onEditing, onSave, onInput, onSelectOffer } = props;

  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [formulaExpression, setFormulaExpression] = useState("");
  const [isEditingFormula, setIsEditingFormula] = useState(false);
  const [legacyTarget, setLegacyTarget] = useState<{ stage: Stage; label: string } | null>(null);
  const [toolbarError, setToolbarError] = useState("");
  const [vendorToRemove, setVendorToRemove] = useState("");
  const removeVendorDialogRef = useRef<HTMLDialogElement | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);
  const formulaCellInputRef = useRef<HTMLInputElement | null>(null);

  const isINU = snapshot?.activeProfile === "INU";

  // Safe mutator
  function apply(action: () => WorkbookSnapshot) {
    if (!onChange) return false;
    try {
      const next = action();
      onChange(next);
      setToolbarError("");
      if (onError) onError("");
      return true;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Operasi gagal.";
      setToolbarError(msg);
      if (onError) onError(msg);
      return false;
    }
  }

  // Active cell helpers
  const allTables = snapshot?.worksheets.flatMap(w => w.tables) ?? [];
  const presentations = new Map(snapshot?.workbook?.cells.map(cell => [cell.cellId, cell]));
  const results = new Map((run?.provisional?.results ?? run?.results)?.map(result => [result.cellId, result]));
  const codes = useMemo(() => snapshot ? cellCodes(snapshot) : new Map<string, string>(), [snapshot]);
  const selectedTable = allTables.find(t => t.cells.some(c => c.id === selectedCellId));
  const selectedCell = selectedTable?.cells.find(c => c.id === selectedCellId);
  const selectedFormula = snapshot?.formulas.find(formula => formula.targetCellId === selectedCellId);
  const formulaMeaning = selectedFormula && snapshot && !isEditingFormula ? describeFormula(selectedFormula.expression, snapshot) : "";
  const selectedMerge = selectedTable?.merges.find(m => m.anchorCellId === selectedCellId);
  const selectedTableLayout = snapshot?.workbook?.tables.find(t => t.tableId === selectedTable?.id);
  const addressOf = (cellId: string) => codes.get(cellId)?.split("!").at(-1) ?? "";

  const activeCellAddress = selectedCell ? addressOf(selectedCell.id)
    : legacyTarget ? `${legacyTarget.stage} / ${legacyTarget.label}` : "Pilih sel";

  function storedExpression(cellId: string) {
    const expression = snapshot?.formulas.find(f => f.targetCellId === cellId)?.expression ?? "";
    return snapshot ? displayFormula(expression, snapshot, cellId) : expression;
  }
  function cancelFormula() {
    setIsEditingFormula(false);
    setFormulaExpression(selectedCell?.source.kind === "INPUT" ? selectedCell.source.input.kind === "UNSET" ? "" : selectedCell.source.input.text
      : selectedCell ? "=" + storedExpression(selectedCell.id) : "");
    formulaInputRef.current?.blur();
  }
  function focusFormulaBar() {
    requestAnimationFrame(() => formulaInputRef.current?.focus());
  }
  function insertReference(cellId: string, referenceSnapshot = snapshot) {
    const input = document.activeElement === formulaInputRef.current ? formulaInputRef.current : formulaCellInputRef.current ?? formulaInputRef.current;
    const start = input?.selectionStart ?? formulaExpression.length;
    const end = input?.selectionEnd ?? formulaExpression.length;
    const reference = referenceSnapshot ? displayFormula(`@{${cellId}}`, referenceSnapshot, selectedCellId ?? undefined) : `@{${cellId}}`;
    setFormulaExpression(value => value.slice(0, start) + reference + value.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + reference.length, start + reference.length); });
  }

  function handleReferencePointerDown(event: PointerEvent<HTMLElement>, cellId: string) {
    if (isEditingFormula && formulaExpression.trimStart().startsWith("=") && event.target !== formulaCellInputRef.current) {
      event.preventDefault(); event.stopPropagation(); insertReference(cellId);
    }
  }

  function handleReferenceClick(event: MouseEvent<HTMLElement>) {
    if (isEditingFormula && formulaExpression.trimStart().startsWith("=") && event.target !== formulaCellInputRef.current) {
      event.preventDefault(); event.stopPropagation();
    }
  }

  const currentRowHeight = selectedTableLayout?.rowHeights.find(r => r.id === selectedCell?.rowId)?.size ?? 23.5;
  const currentColWidth = selectedTableLayout?.columnWidths.find(c => c.id === selectedCell?.columnId)?.size ?? 101;

  // Select cell handler
  function handleSelectCell(cellId: string) {
    if (isEditingFormula) {
      if (formulaExpression.trimStart().startsWith("=")) { insertReference(cellId); return; }
      return;
    }
    setLegacyTarget(null);
    setSelectedCellId(cellId);
    setToolbarError("");
    const formula = snapshot?.formulas.find(f => f.targetCellId === cellId);
    if (formula) {
      setFormulaExpression("=" + displayFormula(formula.expression, snapshot!, cellId));
    } else {
      const cell = allTables.flatMap(t => t.cells).find(c => c.id === cellId);
      setFormulaExpression(cell?.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "");
    }
  }

  function startCellFormula(cellId: string, replace = false) {
    if (isEditingFormula) { insertReference(cellId); return; }
    setSelectedCellId(cellId);
    setLegacyTarget(null);
    setFormulaExpression("=" + (replace ? "" : storedExpression(cellId)));
    setIsEditingFormula(true);
    setToolbarError("");
    requestAnimationFrame(() => formulaCellInputRef.current?.focus());
  }

  function commitCellValue(target: CellSnapshot, rawValue: string) {
    if (!snapshot) return false;
    const raw = rawValue.trim();
    const isFormula = raw.startsWith("=");
    if (isFormula && !raw.slice(1).trim()) { setToolbarError("Rumus wajib diisi setelah =."); return false; }
    const numeric = numericInput(raw);
    const vendorName = snapshot.workbook?.offers.some(o => o.nameCellId === target.id);
    const isVendorCell = snapshot.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.id === target.tableId));
    const vendorAddress = isVendorCell ? addressOf(target.id) : "";
    const vendorText = isVendorCell && (/^B\d+$/.test(vendorAddress) || Number(vendorAddress.match(/\d+$/)?.[0]) <= 9 || /18$/.test(vendorAddress));
    const isTextCell = vendorName || vendorText || presentations.get(target.id)?.unit === "text" || (!snapshot.workbook && target.source.kind === "INPUT" && target.source.input.kind === "TEXT");
    const isNumber = !isTextCell && numericText.test(numeric);
    const saved = apply(() => {
      if (isFormula) return setCellFormula(snapshot, target.id, resolveFormula(raw.slice(1), snapshot, target.id));
      const cleared = target.source.kind === "FORMULA" ? clearCellSource(snapshot, target.id) : snapshot;
      const input = raw ? { kind: isNumber ? "NUMERIC_TEXT" as const : "TEXT" as const, text: isNumber ? numeric : raw } : { kind: "UNSET" as const };
      if (isVendorCell) return updateCellInput(cleared, target.scope, target.id, input);
      if (cleared.workbook) return editSheetInput(cleared, { ...target, source: { kind: "INPUT", input: { kind: "UNSET" } } }, input, history?.map(h => h.revision.snapshot));
      return updateCellInput(cleared, target.scope, target.id, input);
    });
    if (saved) { setIsEditingFormula(false); setFormulaExpression(isFormula ? raw : isNumber ? numeric : raw); }
    return saved;
  }

  function vendorCellEditor(cell: CellSnapshot, label: string) {
    const raw = cell.source.kind === "FORMULA" ? "=" + storedExpression(cell.id)
      : cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
    return <WorksheetCellInput key={cell.id + ":" + raw} label={label} raw={raw} shown={cellValue(cell)} selected={selectedCellId === cell.id}
      editing={isEditingFormula} expression={formulaExpression} disabled={disabled} onFocusInput={input => { formulaCellInputRef.current = input; }}
      onSelect={() => handleSelectCell(cell.id)} onDraft={value => { setFormulaExpression(value); setIsEditingFormula(value.trimStart().startsWith("=")); onEditing?.(); }}
      onCommit={value => commitCellValue(cell, value)} onCancel={cancelFormula} />;
  }

  // Toolbar actions
  function handleApplyFormula(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot) return;
    const raw = formulaExpression.trim();
    const isFormula = raw.startsWith("=");
    let saved = false;
    if (selectedCell) saved = commitCellValue(selectedCell, raw);
    else if (legacyTarget) saved = apply(() => {
      const normalized = numericInput(raw);
      const added = appendField(snapshot, legacyTarget.stage, legacyTarget.stage === "EVALUASI_VENDOR" ? "SHARED" : snapshot.activeProfile,
        legacyTarget.label, isFormula || !raw ? { kind: "UNSET" } : numericText.test(normalized) ? { kind: "NUMERIC_TEXT", text: normalized } : { kind: "TEXT", text: raw });
      setSelectedCellId(added.cellId);
      setLegacyTarget(null);
      return isFormula ? setCellFormula(added.snapshot, added.cellId, resolveFormula(raw.slice(1), added.snapshot, added.cellId)) : added.snapshot;
    });
    event.currentTarget.dataset.commitFailed = saved ? "false" : "true";
    if (saved) setIsEditingFormula(false);
  }

  function handleClearCell() {
    if (!selectedCell || !snapshot) return;
    if (apply(() => selectedCell.source.kind === "INPUT" && snapshot.workbook
      ? editSheetInput(snapshot, selectedCell, { kind: "UNSET" }, history?.map(h => h.revision.snapshot))
      : clearCellSource(snapshot, selectedCell.id))) { setFormulaExpression(""); setIsEditingFormula(false); }
  }

  function handleMerge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCell || !selectedTable || !snapshot) return;
    const form = new FormData(event.currentTarget);
    const rowSpan = Number(form.get("rows")) || 1;
    const colSpan = Number(form.get("columns")) || 1;
    apply(() => mergeCells(snapshot, selectedTable.id, selectedCell.id, { rowSpan, colSpan }));
  }

  function handleUnmerge() {
    if (!selectedTable || !selectedMerge || !snapshot) return;
    apply(() => unmergeCells(snapshot, selectedTable.id, selectedMerge.id));
  }

  function handleAddRow() {
    if (!selectedTable || !snapshot) return;
    const label = `Baris ${selectedTable.rowOrder.length + 1}`;
    apply(() => addRow(snapshot, selectedTable.id, { label, scope: snapshot.activeProfile }));
  }

  function handleAddColumn() {
    if (!selectedTable || !snapshot) return;
    const label = `Kolom ${selectedTable.columnOrder.length + 1}`;
    apply(() => addColumn(snapshot, selectedTable.id, { label, scope: snapshot.activeProfile }));
  }

  function handleRemoveRow() {
    if (!selectedTable || !selectedCell || !snapshot) return;
    apply(() => removeRow(snapshot, selectedTable.id, selectedCell.rowId));
  }

  function handleRemoveColumn() {
    if (!selectedTable || !selectedCell || !snapshot) return;
    apply(() => removeColumn(snapshot, selectedTable.id, selectedCell.columnId));
  }

  function handleResizeRow(size: number) {
    if (!selectedTable || !selectedCell || !snapshot) return;
    apply(() => resizeSheet(snapshot, selectedTable.id, "row", selectedCell.rowId, size));
  }

  function handleResizeCol(size: number) {
    if (!selectedTable || !selectedCell || !snapshot) return;
    apply(() => resizeSheet(snapshot, selectedTable.id, "column", selectedCell.columnId, size));
  }

  function handleAddVendor() {
    if (!snapshot) return;
    apply(() => {
      let next = snapshot;
      const count = Math.max(3, snapshot.analysis.offers.length) + 1;
      while (next.analysis.offers.length < count) next = createVendor(next, `Vendor ${next.analysis.offers.length + 1}`);
      return next;
    });
  }

  function handleRemoveVendor() {
    if (!snapshot || snapshot.analysis.offers.length <= 3) return;
    if (!vendorToRemove) return;
    if (apply(() => removeSheetVendor(snapshot, parseStableId<"offer">(vendorToRemove)))) {
      removeVendorDialogRef.current?.close();
      setVendorToRemove(""); setSelectedCellId(null); setLegacyTarget(null); setFormulaExpression(""); setIsEditingFormula(false);
    }
  }

  function openRemoveVendorDialog() {
    setVendorToRemove(""); setToolbarError("");
    removeVendorDialogRef.current?.showModal();
  }

  function createVendor(current: WorkbookSnapshot, name: string, columnId?: StableId<"column">) {
    if (current.workbook) {
      const patterns = ["C", "D", "E"] as const;
      return addSheetVendor(current, name, patterns[Math.min(current.workbook.offers.length, 2)]!, columnId);
    }
    const vendorId = id<"vendor">(), offerId = id<"offer">();
    return addOffer(addVendor(current, { id: vendorId, analysisId: current.analysisId, name }),
      { id: offerId, analysisId: current.analysisId, vendorId, label: name });
  }

  function handleProfileChange(profile: Profile) {
    if (!snapshot) return;
    apply(() => changeSheetProfile(snapshot, profile));
  }

  function handleSelectOffer(revisionId: string) {
    if (snapshot?.workbook && actor) {
      apply(() => selectSheetOffer(snapshot, parseStableId<"offer-revision">(revisionId), actor));
    } else if (onSelectOffer) {
      onSelectOffer(revisionId);
    }
  }

  function vendorDropdown() {
    const selectedRevision = snapshot?.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId);
    return <select className="conversion-vendor-select" aria-label="Vendor untuk Konversi" value={selectedRevision?.offerId ?? ""}
      disabled={disabled || !snapshot || (!!snapshot.workbook && !actor)} onChange={event => {
        const revision = snapshot?.analysis.offerRevisions.filter(r => r.offerId === event.target.value)
          .reduce<(NonNullable<typeof snapshot>["analysis"]["offerRevisions"])[number] | undefined>((latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
        if (revision) handleSelectOffer(revision.id);
      }}>
      <option value="" disabled>Pilih vendor</option>
      {snapshot?.analysis.offers.map(offer => <option key={offer.id} value={offer.id}
        disabled={!snapshot.analysis.offerRevisions.some(r => r.offerId === offer.id)}>
        {snapshot.analysis.vendors.find(v => v.id === offer.vendorId)?.name ?? offer.label}
      </option>)}
    </select>;
  }

  // Value formatting
  function cellValue(cell: CellSnapshot | undefined, format: "number" | "percentage" | "fixed-number" = "number") {
    if (!cell) return "";
    const result = results.get(cell.id);
    if (result) return "value" in result ? format === "percentage" ? sheetPercent(result.value) : format === "fixed-number" ? sheetNumberFixed(result.value) : sheetNumber(result.value) : "text" in result ? result.text
      : "code" in result && result.code === "WAITING_INPUT" ? "" : result.status === "EMPTY" || cell.source.kind === "INPUT" ? "" : result.status;
    return cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET"
      ? cell.source.input.kind === "NUMERIC_TEXT" ? format === "percentage" ? sheetPercent(cell.source.input.text) : format === "fixed-number" ? sheetNumberFixed(cell.source.input.text) : sheetNumber(cell.source.input.text) : cell.source.input.text : "";
  }

  function cellError(cell: CellSnapshot) {
    const result = results.get(cell.id);
    return result && "code" in result ? `${result.status}: ${result.code}` : undefined;
  }
  const selectedResult = selectedCell ? results.get(selectedCell.id) : undefined;
  const selectedDiagnostic = selectedResult && "code" in selectedResult && (selectedResult.status !== "EMPTY" || selectedResult.code === "WAITING_INPUT")
    ? `${selectedResult.status}: ${selectedResult.code}${selectedResult.path.length ? ` · ${selectedResult.path.map(id => codes.get(id) ?? id).join(" → ")}` : ""}` : "";

  if (!snapshot) return null;
  const removeVendorDialog = <dialog ref={removeVendorDialogRef} className="vendor-delete-dialog" aria-labelledby="vendor-delete-title">
    <form onSubmit={event => { event.preventDefault(); handleRemoveVendor(); }}>
      <header><div><h2 id="vendor-delete-title">Hapus vendor</h2><p>Pilih vendor dari Evaluasi Vendor. Minimal 3 vendor tetap tersedia.</p></div>
        <button type="button" className="dialog-close" aria-label="Tutup" onClick={() => removeVendorDialogRef.current?.close()}>×</button></header>
      <div className="vendor-delete-list">
        {snapshot.analysis.offers.map((offer, index) => {
          const name = snapshot.analysis.vendors.find(vendor => vendor.id === offer.vendorId)?.name || offer.label;
          return <label key={offer.id} className={vendorToRemove === offer.id ? "is-selected" : undefined}>
            <input type="radio" name="vendorToRemove" value={offer.id} checked={vendorToRemove === offer.id} onChange={() => setVendorToRemove(offer.id)} />
            <span className="vendor-delete-index">{String(index + 1).padStart(2, "0")}</span><strong>{name}</strong>
          </label>;
        })}
      </div>
      {toolbarError && <p role="alert" className="vendor-delete-error">{toolbarError}</p>}
      <footer><button type="button" onClick={() => removeVendorDialogRef.current?.close()}>Batal</button>
        <button type="submit" className="vendor-delete-confirm" disabled={disabled || !vendorToRemove || snapshot.analysis.offers.length <= 3}>Hapus vendor</button></footer>
    </form>
  </dialog>;

  // --------------------------------------------------------------------------
  // Dynamic Canvas Rendering (when snapshot.workbook is present)
  // --------------------------------------------------------------------------
  if (snapshot?.workbook) {
    const wVendor = snapshot.worksheets.find(w => w.stage === "EVALUASI_VENDOR");
    const wConversion = snapshot.worksheets.find(w => w.stage === "KONVERSI_JAGAD");
    const wAhs = snapshot.worksheets.find(w => w.stage === "AHS");

    const visibleTables = (worksheet: WorksheetSnapshot | undefined) => worksheet?.tables.filter(t => t.cells.some(c => c.scope === "SHARED" || c.scope === snapshot.activeProfile)) ?? [];
    const vendorTables = visibleTables(wVendor), conversionTables = visibleTables(wConversion), ahsTables = visibleTables(wAhs);

    const offers = snapshot.workbook.offers;
    const vendorColumnsCount = Math.max(3, offers.length);
    const selectedRevisionId = snapshot.selectedOfferRevisionId ?? snapshot.workbook.selections[snapshot.activeProfile];
    const selectedOfferId = snapshot.analysis.offerRevisions.find(revision => revision.id === selectedRevisionId)?.offerId;
    const selectedVendorColumnId = offers.find(offer => offer.offerId === selectedOfferId)?.columnId;
    const sheetStyle = { "--vendor-columns": vendorColumnsCount } as CSSProperties;
    const overviewValue = (key: string) => cellValue(allTables.flatMap(t => t.cells).find(c => c.id === binding(snapshot, snapshot.activeProfile, key)));
    const hppContext = snapshot.profiles[snapshot.activeProfile].reviewContext?.decisionStatus ?? "Belum ditinjau";

    const renderTableGrid = (
      table: TableSnapshot | undefined,
      stage: Stage,
      tableClass: string,
      tableAriaLabel: string
    ) => {
      if (!table) return null;
      const grid = buildSheetGrid(table);
      const layout = snapshot.workbook?.tables.find(p => p.tableId === table.id);

      return (
        <div className="sheet-table-scroll" key={table.id}>
        <table className={tableClass} role="table" aria-label={tableAriaLabel}
          style={{ minWidth: layout?.columnWidths.reduce((sum, column) => sum + column.size, 0) ?? table.columnOrder.length * 101 }}>
          <colgroup>
            {table.columnOrder.map(colId => {
              const width = layout?.columnWidths.find(c => c.id === colId)?.size ?? 101;
              const hiddenVendor = stage === "EVALUASI_VENDOR" && selectedVendorColumnId && offers.some(offer => offer.columnId === colId) && colId !== selectedVendorColumnId;
              return <col key={colId} className={hiddenVendor ? "vendor-unselected" : undefined} style={{ width: `${width}px` }} />;
            })}
          </colgroup>
          <tbody>
            {grid.map((row, rowIndex) => {
              const rowId = table.rowOrder[rowIndex]!;
              const rowMeta = table.rows.find(r => r.id === rowId);
              const address = table.cells.filter(c => c.rowId === rowId).map(c => presentations.get(c.id)?.address).find(Boolean);
              const rowNum = address ? Number(address.match(/\d+$/)?.[0]) + (stage !== "EVALUASI_VENDOR" && !isINU ? 1 : 0) : Number(rowMeta?.label);
              const rowHeight = layout?.rowHeights.find(r => r.id === rowId)?.size ?? 23.5;

              // In Conversion table: hide rows 37..42 when INU is OFF
              if (!isINU && stage === "KONVERSI_JAGAD" && rowNum >= 37 && rowNum <= 42) {
                return null;
              }

              // Determine row-level CSS classes
              let trClass = "";
              if (stage === "EVALUASI_VENDOR") {
                if (rowNum === 3) trClass = "vendor-title";
                else if (rowNum >= 5 && rowNum <= 7) trClass = "vendor-meta";
                else if (rowNum === 9) trClass = "vendor-columns";
                else if (rowNum === 17) trClass = "vendor-total";
                else if (rowNum === 18) trClass = "vendor-notes";
              } else if (stage === "KONVERSI_JAGAD") {
                if (rowNum === 23) trClass = "conversion-title";
                else if (rowNum === 25) trClass = "conversion-period";
                else if (rowNum >= 26 && rowNum <= 27) trClass = "conversion-meta";
                else if (rowNum === 29) trClass = "conversion-columns";
                else if (rowNum === 36) trClass = "conversion-total";
                else if (rowNum >= 38 && rowNum <= 42) {
                  trClass = rowNum === 42 ? "conversion-profit mue-row" : "conversion-profit";
                }
              } else if (stage === "AHS") {
                if (rowNum === 3) trClass = "ahs-title";
                else if (rowNum >= 4 && rowNum <= 7) trClass = "ahs-meta";
                else if (rowNum === 8) trClass = "ahs-meta ahs-include";
                else if (rowNum >= 9 && rowNum <= 13) trClass = rowNum <= 10 ? "income-row income-total" : "income-row";
                else if (rowNum >= 14 && rowNum <= 33) trClass = rowNum <= 15 ? "cost-row cost-total" : "cost-row";
                else if (rowNum >= 34 && rowNum <= 38) trClass = `profit-row${rowNum === 36 ? " profit-net" : rowNum === 38 ? " profit-percent" : ""}`;
                else if (rowNum === 39) trClass = "ahs-notes";
              }

              return (
                <tr key={rowId} className={trClass || undefined} style={{ height: `${rowHeight}px` }}>
                  {row.map((entry, colIndex) => {
                    if (entry === null) return null; // covered by merge
                    const colId = table.columnOrder[colIndex]!;
                    const colMeta = table.columns.find(c => c.id === colId);

                    if (!entry.cell) {
                      return <td key={colIndex} rowSpan={entry.rowSpan} colSpan={entry.colSpan} className="structural-gap" />;
                    }

                    const cell = entry.cell;
                    const meta = presentations.get(cell.id);
                    const cellAddress = addressOf(cell.id);
                    const isSelected = selectedCellId === cell.id;
                    const isHppBase = cell.id === snapshot.profiles[snapshot.activeProfile].hppBase.cellId;
                    const isPinned = snapshot.mappings.some(m => m.sourceCellId === cell.id && m.sourceComponent.startsWith("offer-value:"));
                    const isManualInput = cell.source.kind === "INPUT" && (!meta || meta.kind === "INPUT" || meta.kind === "BLANK") && !isPinned;
                    const isFormulaSlot = meta?.kind === "BLANK" && meta.unit !== "text";

                    // Cell CSS classes
                    const cellClasses: string[] = [];
                    if (stage === "EVALUASI_VENDOR" && selectedVendorColumnId && offers.some(offer => offer.columnId === colId) && colId !== selectedVendorColumnId) cellClasses.push("vendor-unselected");
                    if (isSelected) cellClasses.push("cell-selected");
                    if (stage === "AHS" && colMeta?.label === "G" && ((rowNum >= 11 && rowNum <= 13) || (rowNum >= 16 && rowNum <= 33))) cellClasses.push("category");
                    if (stage === "AHS" && colMeta?.label === "H") cellClasses.push("cost-description");
                    if (stage === "AHS" && (colMeta?.label === "I" || colMeta?.label === "K") && rowNum >= 14 && rowNum <= 33) {
                      cellClasses.push("currency-cell");
                    }
                    if (meta?.unit === "text") cellClasses.push("cell-label");
                    if (isHppBase) cellClasses.push("hpp-base");

                    // Aria label
                    let ariaLabel = "";
                    if (isHppBase) {
                      ariaLabel = "Lembar AHS · HPP · Harga Dasar";
                    } else if (stage === "AHS" && cell.id === binding(snapshot, snapshot.activeProfile, "sale")) {
                      ariaLabel = "Lembar AHS · Harga Jual · Harga Dasar";
                    } else if (stage === "EVALUASI_VENDOR" && rowNum === 5 && colMeta?.label === "D") {
                      ariaLabel = "Lembar EVALUASI_VENDOR · Pekerjaan / Material";
                    } else if (stage === "EVALUASI_VENDOR" && rowNum === 6 && colMeta?.label === "D") {
                      ariaLabel = "Lembar EVALUASI_VENDOR · Customer";
                    } else if (stage === "EVALUASI_VENDOR" && rowNum === 7 && colMeta?.label === "D") {
                      ariaLabel = "Lembar EVALUASI_VENDOR · Lokasi";
                    } else if (stage === "KONVERSI_JAGAD" && rowNum === 25) {
                      ariaLabel = "Lembar KONVERSI_JAGAD · Periode";
                    } else if (stage === "KONVERSI_JAGAD" && rowNum === 26 && colMeta?.label === "C") {
                      ariaLabel = "Lembar KONVERSI_JAGAD · Lokasi";
                    } else {
                      ariaLabel = `Sel ${cellAddress}`;
                    }

                    const isHeaderCell = (stage === "EVALUASI_VENDOR" && (rowNum === 3 || rowNum === 9))
                      || (stage === "KONVERSI_JAGAD" && (rowNum === 23 || rowNum === 29 || colIndex === 0))
                      || (stage === "AHS" && (rowNum === 3 || colMeta?.label === "G" || colMeta?.label === "H" || (rowNum >= 9 && rowNum <= 10 && colMeta?.label === "L")));

                    const CellTag = isHeaderCell ? "th" : "td";

                    // Solved Biaya display for INU D30
                    let displayContent: React.ReactNode = null;
                    if (stage === "EVALUASI_VENDOR") {
                      displayContent = vendorCellEditor(cell, `Evaluasi Vendor · ${cellAddress}`);
                    } else if (stage === "KONVERSI_JAGAD" && cell.id === binding(snapshot, snapshot.activeProfile, "supplierName")) {
                      displayContent = <>{vendorDropdown()}<span className="cell-print-value vendor-print-name">{cellValue(cell)}</span></>;
                    } else if (stage === "KONVERSI_JAGAD" && isINU && meta?.address === "D30" && run?.solver?.cost) {
                      displayContent = <span className="sheet-result" title={run.solver.cost}>{sheetNumber(run.solver.cost)}</span>;
                    } else if (meta?.kind === "LABEL") {
                      displayContent = <span className="sheet-result">{stage === "KONVERSI_JAGAD" && rowNum === 23 ? "Konversi Satuan Jagad" : cellValue(cell)}</span>;
                    } else if (isSelected && isEditingFormula) {
                      displayContent = <><input ref={formulaCellInputRef} className="sheet-input" aria-label={`Rumus ${ariaLabel}`} value={formulaExpression}
                        disabled={disabled} onChange={event => { setFormulaExpression(event.target.value); onEditing?.(); }}
                        onKeyDown={event => { if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); formulaInputRef.current?.form?.requestSubmit(); }
                          if (event.key === "Escape") { event.preventDefault(); cancelFormula(); } }} />
                        <span className="cell-print-value">{cellValue(cell, stage === "KONVERSI_JAGAD" && rowNum === 42 ? "fixed-number" : "number")}</span></>;
                    } else if (isManualInput || (cell.source.kind === "FORMULA" && !isHppBase)) {
                      const raw = cell.source.kind === "FORMULA" ? "=" + storedExpression(cell.id)
                        : cell.source.input.kind === "UNSET" ? "" : cell.source.input.text;
                      const shown = cellValue(cell, stage === "KONVERSI_JAGAD" && rowNum === 42 ? "fixed-number" : "number");
                      displayContent = <>
                        <input
                          key={cell.id + ":" + raw}
                          className="sheet-input"
                          aria-label={ariaLabel}
                          defaultValue={shown}
                          disabled={disabled}
                          inputMode="text"
                          onFocus={event => { handleSelectCell(cell.id); if (event.currentTarget.dataset.invalid !== "true") event.currentTarget.value = raw; event.currentTarget.select(); }}
                          onChange={event => {
                            event.currentTarget.dataset.invalid = "false";
                            setFormulaExpression(event.target.value);
                            onEditing?.();
                            if (event.target.value.trimStart().startsWith("=")) {
                              event.currentTarget.dataset.formulaEditing = "true";
                              setIsEditingFormula(true);
                              requestAnimationFrame(() => {
                                const input = formulaCellInputRef.current;
                                input?.focus();
                                input?.setSelectionRange(input.value.length, input.value.length);
                              });
                            }
                          }}
                          onKeyDown={event => { if (event.key === "Enter") {
                            event.preventDefault(); event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault(); event.currentTarget.value = raw; event.currentTarget.dataset.invalid = "false"; event.currentTarget.blur();
                          } }}
                          onBlur={event => {
                            if (event.currentTarget.dataset.formulaEditing === "true") return;
                            if (event.target.value !== raw) event.currentTarget.dataset.invalid = commitCellValue(cell, event.target.value) ? "false" : "true";
                            else event.currentTarget.value = shown;
                          }}
                        />
                        <span className="cell-print-value">{shown}</span>
                      </>;
                    } else {
                      const val = cellValue(cell, stage === "AHS" && rowNum === 38 ? "percentage" : stage === "KONVERSI_JAGAD" && rowNum === 42 ? "fixed-number" : "number");
                      displayContent = <button type="button" className="cell-readout sheet-result" disabled={disabled}
                        aria-label={`${ariaLabel} · ${val}`}
                        title={[cellAddress, cellError(cell) ?? (isHppBase ? "Mengikuti Biaya Konversi" : val)].filter(Boolean).join(" · ")}
                        onClick={event => { event.stopPropagation(); handleSelectCell(cell.id); }}
                        onDoubleClick={event => { event.stopPropagation(); if (!isHppBase && (cell.source.kind === "FORMULA" || isFormulaSlot)) startCellFormula(cell.id); }}
                        onKeyDown={event => { if (!isHppBase && (cell.source.kind === "FORMULA" || isFormulaSlot) && event.key === "=") {
                          event.preventDefault(); event.stopPropagation(); startCellFormula(cell.id, true);
                        } else if (!isHppBase && cell.source.kind === "FORMULA" && /^\d$/.test(event.key)) {
                          event.preventDefault(); event.stopPropagation(); setSelectedCellId(cell.id); setFormulaExpression(event.key); setIsEditingFormula(true);
                          requestAnimationFrame(() => formulaCellInputRef.current?.focus());
                        } }}>{val}</button>;
                    }

                    return (
                      <CellTag
                        key={cell.id}
                        rowSpan={entry.rowSpan}
                        colSpan={entry.colSpan}
                        data-cell-id={cell.id}
                        data-cell-code={codes.get(cell.id)}
                        title={[cellAddress, cellError(cell)].filter(Boolean).join(" · ")}
                        onPointerDownCapture={event => handleReferencePointerDown(event, cell.id)}
                        onClickCapture={handleReferenceClick}
                        className={cellClasses.join(" ") || undefined}
                        style={{ textAlign: meta?.align, fontWeight: meta?.bold ? 600 : undefined }}
                        tabIndex={0}
                        onKeyDown={event => { if (event.target !== event.currentTarget) return;
                          if (event.key === "=" && !isHppBase && (isManualInput || isFormulaSlot || cell.source.kind === "FORMULA")) { event.preventDefault(); startCellFormula(cell.id, true); }
                          else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleSelectCell(cell.id); }
                        }}
                        onClick={event => { if (!(event.target instanceof HTMLInputElement)) handleSelectCell(cell.id); }}
                      >
                        {colMeta?.label === "I" && stage === "AHS" && rowNum >= 14 && rowNum <= 33 && <span>Rp</span>}
                        {displayContent}
                      </CellTag>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      );
    };

    return (
      <div className="sheet-viewport" aria-label="Lembar procurement" tabIndex={0}>
        {removeVendorDialog}
        <div className="procurement-sheet" style={sheetStyle} data-testid="procurement-sheet">
          <header className="sheet-overview">
            <div><p className="eyebrow">PROCUREMENT WORKSPACE · {isINU ? "INU" : "SOLAR BAWAH"}</p>
              <h2>Evaluasi Vendor & Analisis Harga Satuan</h2>
              <p>{snapshot.project.name} / {snapshot.analysis.analysis.name} · {run?.provisional?.status ?? run?.status ?? "Belum dikonfigurasi"} · Hasil sementara, bukan hasil bisnis final</p></div>
            <dl className="metrics">
              <div><dt>Volume (L)</dt><dd>{overviewValue("volume")}</dd></div>
              <div><dt>Harga jual (Rp/L)</dt><dd>{overviewValue("sale")}</dd></div>
              <div><dt>Laba bersih (Rp)</dt><dd>{overviewValue("profit")}</dd></div>
            </dl>
            <button type="button" className="print-button" onClick={() => requestAnimationFrame(() => window.print())}>Cetak ke PDF</button>
          </header>
          {run?.provisional && <p className="sheet-assumptions">NONFINAL · Asumsi nol sementara: {run.provisional.assumedZeroCellIds.length
            ? run.provisional.assumedZeroCellIds.map(id => displayCellId(id, snapshot)).join(", ") : "tidak ada"}. Sel asli tetap kosong.</p>}
          {/* 1. Unified Formula Bar & Table Actions Toolbar */}
          <div className="sheet-canvas-toolbar">
            <div role="toolbar" aria-label="Formula dan aksi tabel">
            <div className="toolbar-row formula-row">
              <span className="editor-cell-address" aria-label="Alamat sel">{activeCellAddress}</span>
              <form className="formula-bar-form" onSubmit={handleApplyFormula}>
                <input
                  ref={formulaInputRef}
                  aria-label="Formula sel terpilih"
                  value={formulaExpression}
                  data-editing={isEditingFormula}
                  onChange={e => { setIsEditingFormula(true); setFormulaExpression(e.target.value); onEditing?.(); }}
                  onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelFormula(); } }}
                  placeholder={selectedCell ? "Ketik formula atau klik sel lain untuk menyisipkan referensi" : "Pilih sel pada tabel"}
                  disabled={disabled || (!selectedCell && !legacyTarget)}
                />
                <button className="toolbar-button toolbar-button-primary" type="submit" disabled={disabled || (!selectedCell && !legacyTarget)}>Terapkan</button>
                {isEditingFormula && <button className="toolbar-button" type="button" onClick={cancelFormula}>Batal edit</button>}
              </form>
              <button className="toolbar-button toolbar-button-primary" type="button" disabled={disabled} onClick={handleAddVendor}>＋ Tambah vendor</button>
              <button className="toolbar-button toolbar-button-danger" type="button" disabled={disabled || offers.length <= 3} onClick={openRemoveVendorDialog}>− Hapus vendor</button>
              {onSave && <button className="toolbar-button toolbar-button-save" type="button" disabled={disabled} onClick={onSave}>Simpan perubahan</button>}
            </div>
            {formulaMeaning && <p className="formula-meaning">Arti rumus: {formulaMeaning}</p>}
            <details className="structure-details"><summary>Aksi struktur</summary><div className="toolbar-row actions-row">
              <div className="toolbar-group merge-group">
                <form className="merge-controls" onSubmit={handleMerge}>
                  <label>Span baris<input name="rows" type="number" min="1" defaultValue="1" style={{ width: "45px" }} /></label>
                  <label>Span kolom<input name="columns" type="number" min="1" defaultValue="2" style={{ width: "45px" }} /></label>
                  <button type="submit" disabled={disabled || !selectedCell}>Gabung sel</button>
                  <button type="button" disabled={disabled || !selectedMerge} onClick={handleUnmerge}>Pisah sel</button>
                </form>
              </div>
              <div className="toolbar-group structure-group">
                <button type="button" disabled={disabled || !selectedCell} onClick={handleClearCell}>Kosongkan sel</button>
                <button type="button" disabled={disabled || !selectedTable} onClick={handleAddRow}>+ Baris</button>
                <button type="button" disabled={disabled || !selectedTable} onClick={handleAddColumn}>+ Kolom</button>
                <button type="button" disabled={disabled || !selectedCell} onClick={handleRemoveRow}>Hapus baris</button>
                <button type="button" disabled={disabled || !selectedCell} onClick={handleRemoveColumn}>Hapus kolom</button>
              </div>
              <div className="toolbar-group resize-group">
                <label>Tinggi<input disabled={disabled || !selectedCell} type="number" min="18" max="800" value={currentRowHeight} onChange={e => handleResizeRow(Number(e.target.value))} style={{ width: "55px" }} /> px</label>
                <label>Lebar<input disabled={disabled || !selectedCell} type="number" min="18" max="1200" value={currentColWidth} onChange={e => handleResizeCol(Number(e.target.value))} style={{ width: "55px" }} /> px</label>
              </div>
            </div></details>
            {toolbarError && <div className="toolbar-error" role="alert">{toolbarError}</div>}
            {selectedDiagnostic && <div className="toolbar-error" role="status">{selectedDiagnostic}</div>}
            </div>
          </div>

          {/* 2. Left Column: Evaluasi Vendor & Konversi */}
          <div className="sheet-left">
            <section className="sheet-card vendor-card" aria-label="Evaluasi Vendor">
              <div className="sheet-section-title"><h2>Evaluasi harga vendor</h2></div>
              {vendorTables.map(table => renderTableGrid(table, "EVALUASI_VENDOR", "vendor-sheet", "Evaluasi harga vendor"))}
            </section>

            {/* Konversi section with the required INU toggle */}
            <section className="sheet-card conversion-card" aria-label="Satuan Jagad">
            <div className="sheet-section-title"><h2>Konversi Satuan Jagad</h2></div>
            <div className="conversion-control-bar">
              <label className="profile-picker">Profil Konversi
                <select aria-label="Profil Konversi" value={snapshot.activeProfile} disabled={disabled}
                  onChange={event => handleProfileChange(event.target.value as Profile)}>
                  <option value="SOLAR_BAWAH">Solar</option><option value="INU">INU</option>
                </select>
              </label>
              {isINU && run?.solver && (
                <span className="solver-status" aria-live="polite">
                  Biaya: <strong>{run.solver.cost === null ? "—" : sheetNumber(run.solver.cost)}</strong> · Profit MUE: <strong>{run.solver.profit === null ? "—" : sheetNumberFixed(run.solver.profit)}</strong> ({run.solver.status})
                </span>
              )}
            </div>

            {conversionTables.map(table => renderTableGrid(
              table,
              "KONVERSI_JAGAD",
              "conversion-sheet",
              "Konversi Satuan Jagad"
            ))}
            </section>
          </div>

          {/* 3. Right Column: AHS */}
          <section className="sheet-card ahs-card" aria-label="Perhitungan AHS">
            {ahsTables.map(table => renderTableGrid(table, "AHS", "ahs-sheet", "Analisis Harga Satuan AHS"))}
            <p className="hpp-context">HPP Harga Dasar mengikuti Biaya Konversi · Konteks: <strong>{hppContext}</strong></p>
          </section>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Legacy Layout Fallback (when snapshot.workbook is not present)
  // --------------------------------------------------------------------------
  const fields = snapshot?.worksheets.flatMap(w => w.tables.flatMap(t => t.rowOrder.flatMap(rowId => t.columnOrder.flatMap(columnId => {
    const cell = t.cells.find(c => c.rowId === rowId && c.columnId === columnId);
    return cell && (cell.scope === "SHARED" || cell.scope === snapshot.activeProfile)
      ? [{ cell, label: t.rows.find(r => r.id === rowId)!.label, stage: w.stage }] : [];
  })))) ?? [];

  function findLegacy(stage: Stage, label: string) {
    const matches = fields.filter(f => f.stage === stage && normalized(f.label) === normalized(label));
    return matches.length === 1 ? matches[0]!.cell : undefined;
  }

  function selectLegacy(stage: Stage, label: string, cell?: CellSnapshot) {
    if (isEditingFormula && cell && formulaExpression.trimStart().startsWith("=")) { insertReference(cell.id); return; }
    if (isEditingFormula) return;
    setSelectedCellId(cell?.id ?? null);
    setLegacyTarget({ stage, label });
    setFormulaExpression(cell?.source.kind === "INPUT" ? cell.source.input.kind === "UNSET" ? "" : cell.source.input.text : cell?.source.kind === "FORMULA" ? "=" + storedExpression(cell.id) : "");
    setToolbarError("");
  }

  function legacySlot(stage: Stage, label: string, kind: "TEXT" | "NUMERIC_TEXT" = "NUMERIC_TEXT", explicit?: CellSnapshot,
    commit?: (value: string) => void) {
    const cell = explicit ?? findLegacy(stage, label);
    const pinned = cell && snapshot?.mappings.some(m => m.sourceCellId === cell.id && m.sourceComponent.startsWith("offer-value:"));
    const code = cell ? codes.get(cell.id) : undefined;
    const solverCost = stage === "KONVERSI_JAGAD" && label === "Biaya · Harga Dasar" && isINU && !!run?.solver;
    let content: ReactNode;
    if (stage === "EVALUASI_VENDOR" && cell) content = vendorCellEditor(cell, `Evaluasi Vendor · ${label}`);
    else if (cell?.source.kind === "FORMULA" && !pinned && !solverCost && cell.id !== snapshot?.profiles[snapshot.activeProfile].hppBase.cellId) {
      const raw = "=" + storedExpression(cell.id), shown = cellValue(cell, label === "PERSENTASE" ? "percentage" : label === "Profit MUE" ? "fixed-number" : "number");
      content = (<Fragment key={cell.id + ":" + raw}><input className="sheet-input" aria-label={`Lembar ${stage} · ${label}`}
        defaultValue={shown} disabled={disabled || !snapshot} inputMode="text"
        onFocus={event => { selectLegacy(stage, label, cell); if (event.currentTarget.dataset.invalid !== "true") event.currentTarget.value = raw; event.currentTarget.select(); }}
        onChange={event => { event.currentTarget.dataset.invalid = "false"; setFormulaExpression(event.target.value); onEditing?.();
          if (event.target.value.trimStart().startsWith("=")) {
            event.currentTarget.dataset.formulaEditing = "true"; setIsEditingFormula(true); focusFormulaBar();
          } }}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { event.preventDefault(); event.currentTarget.value = raw; event.currentTarget.dataset.invalid = "false"; event.currentTarget.blur(); } }}
        onBlur={event => { if (event.currentTarget.dataset.formulaEditing === "true") return;
          if (event.target.value !== raw) event.currentTarget.dataset.invalid = commitCellValue(cell, event.target.value) ? "false" : "true";
          else event.currentTarget.value = shown; }} /><span className="cell-print-value">{shown}</span></Fragment>);
    } else if (cell && (cell.source.kind !== "INPUT" || pinned || solverCost)) { content = (<button type="button" className="cell-readout sheet-result"
      title={[addressOf(cell.id), cellError(cell) ?? cellValue(cell, label === "PERSENTASE" ? "percentage" : label === "Profit MUE" ? "fixed-number" : "number")].filter(Boolean).join(" · ")} disabled={disabled} onClick={() => {
        selectLegacy(stage, label, cell);
      }}
      onDoubleClick={() => { if (cell.source.kind === "FORMULA" && cell.id !== snapshot?.profiles[snapshot.activeProfile].hppBase.cellId) { setIsEditingFormula(true); focusFormulaBar(); } }}
      onKeyDown={event => { if (event.key === "=" && cell.id !== snapshot?.profiles[snapshot.activeProfile].hppBase.cellId) { event.preventDefault(); selectLegacy(stage, label, cell); setFormulaExpression("="); setIsEditingFormula(true); focusFormulaBar(); } }}>{cellValue(cell, label === "PERSENTASE" ? "percentage" : label === "Profit MUE" ? "fixed-number" : "number")}</button>);
    } else {
      const raw = cell?.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
      content = (<Fragment key={(cell?.id ?? label) + ":" + raw}><input className="sheet-input" aria-label={`Lembar ${stage} · ${label}`}
        defaultValue={raw} disabled={disabled || !snapshot} inputMode={kind === "TEXT" ? "text" : "decimal"}
        onFocus={event => { selectLegacy(stage, label, cell); if (cell) event.currentTarget.select(); }}
        onChange={event => { event.currentTarget.dataset.invalid = "false"; setFormulaExpression(event.target.value); onEditing?.();
          if (event.target.value.trimStart().startsWith("=")) {
            event.currentTarget.dataset.formulaEditing = "true"; setIsEditingFormula(true); focusFormulaBar();
          } }}
        onKeyDown={event => { if (event.key === "=" && !cell) {
          event.preventDefault(); selectLegacy(stage, label, cell); setFormulaExpression("="); setIsEditingFormula(true);
          focusFormulaBar();
        } else if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { event.currentTarget.value = raw; event.currentTarget.dataset.invalid = "false"; event.currentTarget.blur(); }
        }}
        onBlur={event => { if (event.currentTarget.dataset.formulaEditing === "true") return;
          if (event.target.value !== raw && (onInput || commit)) {
          if (cell && !commit) { event.currentTarget.dataset.invalid = commitCellValue(cell, event.target.value) ? "false" : "true"; return; }
          if (commit) commit(event.target.value);
          else {
            const value = event.target.value, numericValue = numericInput(value), isNumeric = numericText.test(numericValue);
            onInput?.(stage, label, isNumeric ? numericValue : value, isNumeric ? "NUMERIC_TEXT" : "TEXT", cell);
          }
          }
        }} /><span className="cell-print-value">{raw ? kind === "TEXT" ? raw : label === "PERSENTASE" ? sheetPercent(raw) : label === "Profit MUE" ? sheetNumberFixed(raw) : sheetNumber(raw) : ""}</span></Fragment>);
    }
    return <span className={`sheet-cell${cell?.id === selectedCellId ? " cell-selected" : ""}`}
      data-cell-id={cell?.id} data-cell-code={code} title={cell ? [addressOf(cell.id), cellError(cell)].filter(Boolean).join(" · ") : undefined}
      onPointerDownCapture={event => { if (cell) handleReferencePointerDown(event, cell.id); }}
      onClickCapture={event => { if (cell) handleReferenceClick(event); }}>{content}</span>;
  }

  function vendorSlot(address: string, label: string) {
    const parts = /^([A-Z]+)(\d+)$/.exec(address);
    const offer = parts && parts[1] !== "B" && Number(parts[2]) >= 9
      ? snapshot?.analysis.offers.find((_, index) => vendorColumn(index) === parts[1]) : undefined;
    const cell = fields.find(f => f.stage === "EVALUASI_VENDOR" && (offer
      ? f.label.includes(`|vendor:${offer.id}:`) && codes.get(f.cell.id)?.match(/\d+$/)?.[0] === parts?.[2]
      : codes.get(f.cell.id) === `EV!${address}`))?.cell;
    return cell ? legacySlot("EVALUASI_VENDOR", label, "NUMERIC_TEXT", cell) : <span role="alert">Sel {address} belum tersedia</span>;
  }

  const selected = snapshot?.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId);
  const legacyOffers = snapshot?.analysis.offers.map(offer => {
    const revisions = snapshot.analysis.offerRevisions.filter(r => r.offerId === offer.id);
    const latest = revisions.reduce<typeof selected>((latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
    return { offer, revision: latest,
      vendor: snapshot.analysis.vendors.find(v => v.id === offer.vendorId)! };
  }) ?? [];
  const legacyVendorColumns = Math.max(3, legacyOffers.length);
  const extraVendorRows = [...new Set(legacyOffers.flatMap(o => o.revision?.values.map(v => v.label) ?? []))]
    .filter(label => !label.startsWith("formula:") && !["Nama vendor", "Notes", "TOTAL", ...vendorRows].some(row => normalized(row) === normalized(label)));
  const hpp = fields.find(f => f.cell.id === snapshot?.profiles[snapshot.activeProfile].hppBase.cellId)?.cell;
  const header = (label: string, className: string) => <tr key={label} className={className}><th colSpan={5}>{label}</th><td>{legacySlot("AHS", label)}</td></tr>;
  const conversionColumns = ["Harga INU", "Biaya"];
  const sheetStyle = { "--vendor-columns": legacyVendorColumns } as CSSProperties;
  const legacyOverviewValue = (stage: Stage, label: string, format: "number" | "percentage" = "number") =>
    cellValue(findLegacy(stage, label), format);

  return (
    <div className="sheet-viewport" aria-label="Lembar procurement" tabIndex={0}>
      {removeVendorDialog}
      <div className="procurement-sheet" style={sheetStyle} data-testid="procurement-sheet">
        <header className="sheet-overview">
          <div><p className="eyebrow">PROCUREMENT WORKSPACE · {isINU ? "INU" : "SOLAR BAWAH"}</p>
            <h2>Evaluasi Vendor &amp; Analisis Harga Satuan</h2>
            <p>{snapshot.project.name} / {snapshot.analysis.analysis.name} · {run?.provisional?.status ?? run?.status ?? "Belum dikonfigurasi"} · Hasil sementara, bukan hasil bisnis final</p></div>
          <dl className="metrics">
            <div><dt>Volume (L)</dt><dd>{legacyOverviewValue("AHS", "Harga Jual · Harga Dasar · Volume")}</dd></div>
            <div><dt>Harga jual (Rp/L)</dt><dd>{legacyOverviewValue("AHS", "Harga Jual · Harga Dasar")}</dd></div>
            <div><dt>Laba bersih (Rp)</dt><dd>{legacyOverviewValue("AHS", "LABA BERSIH")}</dd></div>
          </dl>
          <button type="button" className="print-button" onClick={() => requestAnimationFrame(() => window.print())}>Cetak ke PDF</button>
        </header>
        <div className="sheet-canvas-toolbar">
          <div className="toolbar-row formula-row">
            <span className="editor-cell-address" aria-label="Alamat sel">{activeCellAddress}</span>
            <form className="formula-bar-form" onSubmit={handleApplyFormula}>
              <input ref={formulaInputRef} aria-label="Formula sel terpilih" value={formulaExpression} data-editing={isEditingFormula}
                disabled={disabled || (!selectedCell && !legacyTarget)}
                onChange={event => { setIsEditingFormula(true); setFormulaExpression(event.target.value); onEditing?.(); }}
                onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelFormula(); } }}
                placeholder="Ketik = lalu klik sel sumber" />
              <button className="toolbar-button toolbar-button-primary" disabled={disabled || (!selectedCell && !legacyTarget)}>Terapkan</button>
              {isEditingFormula && <button className="toolbar-button" type="button" onClick={cancelFormula}>Batal edit</button>}
            </form>
            <button className="toolbar-button toolbar-button-primary" type="button" disabled={disabled} onClick={handleAddVendor}>＋ Tambah vendor</button>
            <button className="toolbar-button toolbar-button-danger" type="button" disabled={disabled || legacyOffers.length <= 3} onClick={openRemoveVendorDialog}>− Hapus vendor</button>
            {onSave && <button className="toolbar-button toolbar-button-save" type="button" disabled={disabled} onClick={onSave}>Simpan perubahan</button>}
          </div>
          {formulaMeaning && <p className="formula-meaning">Arti rumus: {formulaMeaning}</p>}
          {toolbarError && <div className="toolbar-error" role="alert">{toolbarError}</div>}
          {selectedDiagnostic && <div className="toolbar-error" role="status">{selectedDiagnostic}</div>}
        </div>
        <div className="sheet-left">
          <div className="sheet-section-title"><h2>Evaluasi harga vendor</h2></div>
          <table className="vendor-sheet" aria-label="Evaluasi harga vendor">
            <colgroup>{Array.from({ length: legacyVendorColumns + 1 }, (_, i) => <col key={i} className={i > 0 && selected && selected.offerId !== legacyOffers[i - 1]?.offer.id ? "vendor-unselected" : undefined} />)}</colgroup>
            <thead><tr className="vendor-title"><th colSpan={legacyVendorColumns + 1}>{vendorSlot("B3", "Judul")}</th></tr></thead>
            <tbody>
              <tr className="sheet-spacer"><td colSpan={legacyVendorColumns + 1}>{vendorSlot("B4", "Baris 4")}</td></tr>
              {["Pekerjaan / Material", "Customer", "Lokasi"].map((label, index) => (
                <tr className="vendor-meta" key={label}>
                  <td colSpan={2}>{vendorSlot(`B${index + 5}`, `Label ${label}`)}</td>
                  <td colSpan={legacyVendorColumns - 1}>{vendorSlot(`D${index + 5}`, label)}</td>
                </tr>
              ))}
              <tr className="sheet-spacer"><td colSpan={legacyVendorColumns + 1}>{vendorSlot("B8", "Baris 8")}</td></tr>
              <tr className="vendor-columns"><th>{vendorSlot("B9", "Uraian")}</th>{legacyOffers.map((entry, index) => (
                <th key={entry.offer.id} className={selected && selected.offerId !== entry.offer.id ? "vendor-unselected" : undefined}>{vendorSlot(`${vendorColumn(index)}9`, `Nama vendor ${index + 1}`)}</th>
              ))}</tr>
              {[...vendorRows, ...extraVendorRows].map((label, index) => {
                const row = index < vendorRows.length ? index + 10 : index - vendorRows.length + 19;
                return <tr key={label}><td>{vendorSlot(`B${row}`, `Label ${label}`)}</td>{legacyOffers.map((entry, vendorIndex) => (
                  <td className={`sheet-number${selected && selected.offerId !== entry.offer.id ? " vendor-unselected" : ""}`} key={entry.offer.id}>{vendorSlot(`${vendorColumn(vendorIndex)}${row}`, `${entry.vendor.name} · ${label}`)}</td>
                ))}</tr>;
              })}
              <tr className="vendor-total"><td>{vendorSlot("B17", "Label TOTAL")}</td>{legacyOffers.map((entry, index) => (
                <td className={selected && selected.offerId !== entry.offer.id ? "vendor-unselected" : undefined} key={entry.offer.id}>{vendorSlot(`${vendorColumn(index)}17`, `${entry.vendor.name} · TOTAL`)}</td>
              ))}</tr>
              <tr className="vendor-notes"><td>{vendorSlot("B18", "Label Notes")}</td>{legacyOffers.map((entry, index) => (
                <td className={selected && selected.offerId !== entry.offer.id ? "vendor-unselected" : undefined} key={entry.offer.id}>{vendorSlot(`${vendorColumn(index)}18`, `${entry.vendor.name} · Notes`)}</td>
              ))}</tr>
            </tbody>
          </table>

          <div className="conversion-control-bar">
            <label className="profile-picker">Profil Konversi
              <select aria-label="Profil Konversi" value={snapshot?.activeProfile ?? "SOLAR_BAWAH"} disabled={disabled}
                onChange={event => handleProfileChange(event.target.value as Profile)}>
                <option value="SOLAR_BAWAH">Solar</option><option value="INU">INU</option>
              </select>
            </label>
          </div>


          <table className="conversion-sheet" aria-label="Konversi Satuan Jagad">
            <colgroup><col /><col /><col /></colgroup>
            <thead><tr><th colSpan={3}>Konversi Satuan Jagad</th></tr></thead>
            <tbody>
              <tr className="sheet-spacer"><td colSpan={3} /></tr>
              <tr className="conversion-period"><th colSpan={3}>{legacySlot("KONVERSI_JAGAD", "Periode", "TEXT")}</th></tr>
              <tr className="conversion-meta"><th>Lokasi <span>:</span></th><td colSpan={2}>{legacySlot("KONVERSI_JAGAD", "Lokasi", "TEXT")}</td></tr>
              <tr className="conversion-meta"><th>Nama {snapshot?.activeProfile === "SOLAR_BAWAH" ? "Solar" : "INU"} <span>:</span></th><td colSpan={2}>{vendorDropdown()}<span className="cell-print-value vendor-print-name">{selected ? legacyOffers.find(o => o.offer.id === selected.offerId)?.vendor.name : ""}</span></td></tr>
              <tr className="sheet-spacer"><td colSpan={3} /></tr>
              <tr className="conversion-columns"><th>Uraian</th><th>{snapshot?.activeProfile === "SOLAR_BAWAH" ? "Harga Solar" : "Harga INU"}</th><th>Biaya</th></tr>
              {conversionRows.map((label, index) => (
                <tr key={index} className={label === "ALL IN" ? "conversion-total" : ""}>
                  <th>{label}</th>
                  {conversionColumns.map(column => <td key={column}>{legacySlot("KONVERSI_JAGAD", `${column} · ${label}${label === "PPN" && index === 5 ? " OAT" : ""}`)}</td>)}
                </tr>
              ))}
              {isINU && <>
                <tr className="sheet-spacer profit-spacer"><td colSpan={3} /></tr>
                {["Gross Profit", "BPH Migas", "Net Margin", "PPH", "Profit MUE"].map(label => (
                  <tr key={label} className={label === "Profit MUE" ? "conversion-profit mue-row" : "conversion-profit"}>
                    <td>{label}</td>
                    <td>{legacySlot("KONVERSI_JAGAD", label)}</td>
                    <td>{label === "Profit MUE" ? "Crosscheck" : ""}</td>
                  </tr>
                ))}
              </>}
            </tbody>
          </table>
        </div>

        <table className="ahs-sheet" aria-label="Analisis Harga Satuan AHS">
          <colgroup>{Array.from({ length: 6 }, (_, i) => <col key={i} />)}</colgroup>
          <thead><tr className="ahs-title"><th colSpan={6}>ANALISIS HARGA SATUAN (AHS)</th></tr></thead>
          <tbody>
            {[["Tgl Analisis (Rn)", "Sumber"], ["Marketing", "Lokasi"], ["Pembayaran", "Dokumen"], ["Harga Keekonomian", "Diskon"]].map(pair => (
              <tr className="ahs-meta" key={pair[0]}>
                {pair.map(label => <Fragment key={label}><th>{label}</th><td colSpan={2}>{legacySlot("AHS", label, "TEXT")}</td></Fragment>)}
              </tr>
            ))}
            <tr className="ahs-meta ahs-include"><th colSpan={3}>HARGA INCLUDE</th><td colSpan={3}>{legacySlot("AHS", "Harga Include")}</td></tr>
            {header("TOTAL PENDAPATAN", "income-row")}{header("HARGA JUAL SETELAH PAJAK", "income-row")}
            {["Harga Dasar", "PBBKB", "PPN 11%"].map((label, index) => (
              <tr className="income-row" key={label}>
                {index === 0 && <th rowSpan={3} className="category">HARGA JUAL</th>}
                <td className="cost-description" title={label}>{label}</td>
                <td>{legacySlot("AHS", `Harga Jual · ${label}`)}</td><td>{legacySlot("AHS", `Harga Jual · ${label} · Volume`)}</td><td>{legacySlot("AHS", `Harga Jual · ${label} · Total`)}</td><td />
              </tr>
            ))}
            {header("TOTAL BIAYA", "cost-row")}{header("BIAYA PER LITER", "cost-row")}
            {costGroups.flatMap(group => group.rows.map((label, index) => (
              <tr className="cost-row" key={group.label + label}>
                {index === 0 && <th rowSpan={group.rows.length} className="category">{group.label}</th>}
                <td className="cost-description" title={label}>{label}</td>
                <td className="currency-cell"><span>Rp</span>{legacySlot("AHS", `${group.label} · ${label}`, "NUMERIC_TEXT", group.label === "HPP" && index === 0 ? hpp : undefined)}</td>
                <td>{legacySlot("AHS", `${group.label} · ${label} · Volume`)}</td>
                <td colSpan={2} className="currency-cell"><span>Rp</span>{legacySlot("AHS", `${group.label} · ${label} · Total`)}</td>
              </tr>
            )))}
            {summaryRows.map(label => header(label, "profit-row"))}
            <tr className="ahs-notes"><td colSpan={6}>Notes{legacySlot("AHS", "Notes", "TEXT")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
