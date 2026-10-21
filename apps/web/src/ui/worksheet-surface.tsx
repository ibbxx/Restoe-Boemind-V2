"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import type { AhsSection, CellSnapshot, TableSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "../domain/contracts.ts";
import type { Profile } from "../domain/profiles.ts";
import type { StableId } from "../domain/ids.ts";
import { ANALYSIS_STATUSES, analysisStatusLabel } from "../domain/analysis-status.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { buildSheetGrid, sheetNumber, sheetNumberFixed, sheetPercent } from "./sheet-grid.ts";
import { addColumn, addRow, clearCellSource, mergeCells, removeColumn, removeRow, setCellFormula, unmergeCells } from "../domain/structure.ts";
import { addSheetVendor, changeSheetProfile, editSheetInput, removeSheetVendor, resizeSheet, selectSheetOffer } from "../domain/dynamic-workflow.ts";
import { updateCellInput } from "../domain/commands.ts";
import { binding } from "../domain/procurement-template.ts";
import { addOffer, addVendor } from "../domain/commands.ts";
import { appendField } from "../domain/workflow.ts";
import { cellCodes, describeFormula, displayCellId, displayFormula, resolveFormula } from "../domain/cell-address.ts";
import { prepareLegacySheet, vendorColumn } from "../domain/legacy-sheet.ts";
import { numericInput } from "../domain/numeric-input.ts";
import { ahsVolumeSource, isAhsVolumeCell, isAhsVolumeFollower } from "../domain/ahs-volume.ts";
import { WorksheetCellInput } from "./worksheet-cell-input.tsx";
import { printWorkbook, workbookPrintTitle } from "./print-workbook.ts";
import { addVendorComponent, includeNewVendorComponentTotals, removableVendorComponents, removeVendorComponent, vendorComponents, vendorComponentRoles } from "../domain/vendor-components.ts";
import { ahsCell, ahsGroups, ahsLabel, ahsSectionOfCell, removeAhsEntry } from "../domain/ahs-groups.ts";
import { ahsFields, removeAhsField } from "../domain/ahs-fields.ts";
import { AhsActions } from "./ahs-actions.tsx";
import { MenuToggleIcon } from "../components/ui/menu-toggle-icon.tsx";

type Stage = WorksheetSnapshot["stage"];

interface SurfaceProps {
  snapshot: WorkbookSnapshot | null;
  run: EngineRun | null;
  configuration: EngineConfiguration | null;
  disabled: boolean;
  saving?: boolean;
  onPrintLoading?: (preparing: boolean) => void;
  volumeError?: string;
  actor?: StableId<"user"> | null;
  onChange?: (next: WorkbookSnapshot) => void;
  onError?: (error: string) => void;
  onEditing?: () => void;
  onSave?: () => void;
  analysisStatus?: AnalysisStatus | undefined;
  onAnalysisStatusChange?: (status: AnalysisStatus) => void;
  onRequestConfirm?: (title: string, description: string, onConfirm: () => void) => void;
  onInput?: (stage: Stage, label: string, value: string, kind: "TEXT" | "NUMERIC_TEXT", cell: CellSnapshot | undefined) => void;
  onSelectOffer?: (selectionId: string, vendorName: string) => void;
}

const summaryRows = ["LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE"];
const normalized = (text: string) => text.trim().toLocaleLowerCase("id-ID");
const numericText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function WorksheetSurface(props: SurfaceProps) {
  const { snapshot, run, configuration, disabled, saving = false, onPrintLoading, volumeError, actor, onChange, onError, onEditing, onSave, analysisStatus, onAnalysisStatusChange, onInput, onSelectOffer, onRequestConfirm } = props;

  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [formulaExpression, setFormulaExpression] = useState("");
  const [isEditingFormula, setIsEditingFormula] = useState(false);
  const [legacyTarget, setLegacyTarget] = useState<{ stage: Stage; label: string } | null>(null);
  const [toolbarError, setToolbarError] = useState("");
  const [isPreparingPrint, setIsPreparingPrint] = useState(false);
  useEffect(() => () => onPrintLoading?.(false), [onPrintLoading]);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [vendorToRemove, setVendorToRemove] = useState("");
  const removeVendorDialogRef = useRef<HTMLDialogElement | null>(null);
  const addComponentDialogRef = useRef<HTMLDialogElement | null>(null);
  const [newComponentName, setNewComponentName] = useState("");
  const vendorMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const removeComponentDialogRef = useRef<HTMLDialogElement | null>(null);
  const [componentToRemove, setComponentToRemove] = useState("");
  const formulaInputRef = useRef<HTMLInputElement | null>(null);
  const formulaCellInputRef = useRef<HTMLInputElement | null>(null);
  const ahsAddButtonsRef = useRef<Partial<Record<AhsSection, HTMLButtonElement | null>>>({});

  const isINU = snapshot?.activeProfile === "INU";
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && vendorMenuRef.current && !vendorMenuRef.current.contains(event.target)) vendorMenuRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function focusVendorMenu() { vendorMenuRef.current?.querySelector("summary")?.focus(); }

  function menuAction(action: () => void) {
    if (vendorMenuRef.current) vendorMenuRef.current.open = false;
    action();
    if (!document.querySelector("dialog[open]")) focusVendorMenu();
  }

  function openRemoveComponentDialog() {
    setComponentToRemove(""); setToolbarError("");
    removeComponentDialogRef.current?.showModal();
  }

  function handleRemoveComponent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !configuration || !componentToRemove || disabled) return;
    if (apply(() => removeVendorComponent(snapshot, componentToRemove, configuration))) {
      removeComponentDialogRef.current?.close();
      setSelectedCellId(null); setLegacyTarget(null); setFormulaExpression(""); setIsEditingFormula(false);
    }
  }

  async function handlePrint() {
    if (!snapshot || isPreparingPrint) return;
    if (volumeError) { setToolbarError(volumeError); return; }
    const selectionId = snapshot.workbook ? snapshot.workbook.selections[snapshot.activeProfile] : snapshot.selectedOfferId;
    const offerId = snapshot.analysis.offers.find(activeOffer => activeOffer.id === selectionId)?.id;
    if (!offerId) { setToolbarError("Pilih vendor untuk Konversi sebelum mencetak."); return; }
    setIsPreparingPrint(true);
    onPrintLoading?.(true);
    try {
      if (isEditingFormula) {
        const form = formulaInputRef.current?.form;
        form?.requestSubmit();
        if (form?.dataset.commitFailed === "true") return;
      }
      if (document.activeElement instanceof HTMLInputElement && sheetRef.current?.contains(document.activeElement)) document.activeElement.blur();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const sheet = sheetRef.current;
      if (!sheet) return;
      if (sheet.querySelector('.sheet-input[data-invalid="true"]')) throw new Error("Perbaiki input sel sebelum mencetak.");
      let indexes: number[];
      if (snapshot.workbook) {
        const table = snapshot.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.find(t =>
          t.cells.some(cell => cell.scope === "SHARED" || cell.scope === snapshot.activeProfile));
        indexes = snapshot.analysis.offers.map(offer => {
          const columnId = snapshot.workbook!.offers.find(entry => entry.offerId === offer.id)?.columnId;
          return columnId ? table?.columnOrder.indexOf(columnId) ?? -1 : -1;
        }).sort((a, b) => a - b);
      } else indexes = snapshot.analysis.offers.map((_, index) => index + 1);
      if (!indexes.length || indexes.some(index => index < 1)) throw new Error("Kolom vendor untuk cetak tidak ditemukan.");
      await printWorkbook(sheet, indexes, sheet.dataset.printTitle!);
    } catch (cause) { setToolbarError(cause instanceof Error ? cause.message : "Laporan gagal disiapkan."); }
    finally { setIsPreparingPrint(false); onPrintLoading?.(false); }
  }

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
  const selectedVolumeFollower = !!snapshot && !!selectedCell && isAhsVolumeFollower(snapshot, selectedCell);
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
    if (event.target instanceof Element && event.target.closest(".vendor-table-actions")) return;
    if (isEditingFormula && formulaExpression.trimStart().startsWith("=") && event.target !== formulaCellInputRef.current) {
      event.preventDefault(); event.stopPropagation(); insertReference(cellId);
    }
  }

  function handleReferenceClick(event: MouseEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest(".vendor-table-actions")) return;
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
    const target = allTables.flatMap(table => table.cells).find(cell => cell.id === cellId);
    if (snapshot && target && isAhsVolumeFollower(snapshot, target)) { handleSelectCell(cellId); return; }
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
    if (snapshot.mappings.some(mapping => mapping.targetCellId === target.id && mapping.sourceComponent.startsWith("project-location-live:"))) {
      setToolbarError("Edit Lokasi pada detail proyek Evaluasi Vendor."); return false;
    }
    if (snapshot.mappings.some(mapping => mapping.targetCellId === target.id && mapping.sourceComponent.startsWith("vendor-live:"))) {
      setToolbarError("Edit nilai ini di tabel Evaluasi Vendor."); return false;
    }
    const raw = rawValue.trim();
    const isFormula = raw.startsWith("=");
    if (isFormula && !raw.slice(1).trim()) { setToolbarError("Rumus wajib diisi setelah =."); return false; }
    const numeric = numericInput(raw);
    const isVolume = isAhsVolumeCell(snapshot, target);
    if (isVolume && raw && !isFormula && !numericText.test(numeric)) {
      setToolbarError("Volume AHS wajib berupa angka. Contoh: 50.000 atau 50000."); return false;
    }
    const vendorName = snapshot.workbook?.offers.some(o => o.nameCellId === target.id);
    const isVendorCell = snapshot.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.id === target.tableId));
    const vendorAddress = isVendorCell ? addressOf(target.id) : "";
    const vendorText = isVendorCell && (/^B\d+$/.test(vendorAddress) || Number(vendorAddress.match(/\d+$/)?.[0]) <= 9 || /18$/.test(vendorAddress));
    const isVendorComponent = isVendorCell && snapshot.analysis.offers.some(offer => vendorComponents(snapshot, offer.id).some(component => component.source.id === target.id));
    const textField = snapshot.ahsFields?.some(field => field.valueCellId === target.id && field.valueType === "TEXT");
    const isTextCell = !isVolume && (textField || vendorName || vendorText || (!isVendorComponent && (presentations.get(target.id)?.unit === "text" || (!snapshot.workbook && target.source.kind === "INPUT" && target.source.input.kind === "TEXT"))));
    const isNumber = !isTextCell && numericText.test(numeric);
    const saved = apply(() => {
      if (isFormula) return setCellFormula(snapshot, target.id, resolveFormula(raw.slice(1), snapshot, target.id));
      const cleared = target.source.kind === "FORMULA" ? clearCellSource(snapshot, target.id) : snapshot;
      const input = raw ? { kind: isNumber ? "NUMERIC_TEXT" as const : "TEXT" as const, text: isNumber ? numeric : raw } : { kind: "UNSET" as const };
      if (isVendorCell) return updateCellInput(cleared, target.scope, target.id, input);
      if (cleared.workbook) return editSheetInput(cleared, { ...target, source: { kind: "INPUT", input: { kind: "UNSET" } } }, input);
      return updateCellInput(cleared, target.scope, target.id, input);
    });
    if (saved) { setIsEditingFormula(false); setFormulaExpression(isFormula ? raw : isNumber ? numeric : raw); }
    return saved;
  }

  function worksheetCellEditor(cell: CellSnapshot, label: string, format: "number" | "percentage" = "number") {
    if (snapshot && isAhsVolumeFollower(snapshot, cell)) return <button type="button" className="cell-readout sheet-result" disabled={disabled}
      aria-label={label} title="Mengikuti Volume Harga Jual · Harga Dasar" onClick={() => handleSelectCell(cell.id)}>{cellValue(cell)}</button>;
    const raw = cell.source.kind === "FORMULA" ? "=" + storedExpression(cell.id)
      : cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
    return <WorksheetCellInput key={cell.id + ":" + raw} label={label} raw={raw} shown={cellValue(cell, format)} selected={selectedCellId === cell.id}
      needsCommit={!!snapshot && isAhsVolumeCell(snapshot, cell) && cell.source.kind === "INPUT" && cell.source.input.kind === "TEXT"}
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
      ? editSheetInput(snapshot, selectedCell, { kind: "UNSET" })
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
    if (snapshot.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.id === selectedTable.id))) { openAddComponentDialog(); return; }
    if (snapshot.worksheets.some(w => w.stage === "AHS" && w.tables.some(t => t.id === selectedTable.id))) {
      const addAction = ahsAddButtonsRef.current["INFORMASI"];
      addAction?.closest("details")?.querySelector<HTMLElement>("summary")?.click();
      return;
    }
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
    if (snapshot.worksheets.some(w => w.stage === "AHS" && w.tables.some(t => t.id === selectedTable.id))) {
      const section = ahsSectionOfCell(snapshot, selectedCell);
      const field = snapshot.ahsFields?.find(f => f.profile === snapshot.activeProfile && ahsCell(snapshot, f.valueCellId)?.rowId === selectedCell.rowId);
      if (field && configuration) {
        onRequestConfirm?.("Hapus uraian", `Hapus uraian “${ahsLabel(snapshot, field)}” beserta nilainya?`, () => apply(() => removeAhsField(snapshot, field.valueCellId, configuration)));
        return;
      }
      const group = (section === "PENDAPATAN" || section === "BIAYA" ? ahsGroups(snapshot, snapshot.activeProfile, section) : []).find(g => g.items.some(item => ahsCell(snapshot, item.priceCellId)?.rowId === selectedCell.rowId ||
        [item.priceCellId, item.volumeCellId, item.totalCellId].includes(selectedCell.id)));
      const item = group?.items.find(item => ahsCell(snapshot, item.priceCellId)?.rowId === selectedCell.rowId ||
        [item.priceCellId, item.volumeCellId, item.totalCellId].includes(selectedCell.id));
      if (!group || !item || !configuration) { setToolbarError("Baris inti AHS tidak dapat dihapus."); return; }
      onRequestConfirm?.("Hapus uraian", `Hapus uraian “${ahsLabel(snapshot, item)}” beserta nilainya?`, () => apply(() => removeAhsEntry(snapshot, group.id, item.priceCellId, configuration, section === "PENDAPATAN" ? section : "BIAYA")));
      return;
    }
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

  function openAddComponentDialog() {
    setNewComponentName(""); setToolbarError("");
    addComponentDialogRef.current?.showModal();
  }

  function handleAddComponent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || disabled) return;
    let firstCellId: StableId<"cell"> | undefined;
    const saved = apply(() => {
      const added = addVendorComponent(snapshot, newComponentName);
      firstCellId = added.firstCellId;
      return added.snapshot;
    });
    if (saved && firstCellId) {
      addComponentDialogRef.current?.close();
      setSelectedCellId(firstCellId); setLegacyTarget(null); setFormulaExpression(""); setIsEditingFormula(false);
      requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLInputElement>(`[data-cell-id="${firstCellId}"] .sheet-input`)?.focus());
    }
  }

  function createVendor(current: WorkbookSnapshot, name: string, columnId?: StableId<"column">) {
    if (current.workbook) {
      const patterns = ["C", "D", "E"] as const;
      return addSheetVendor(current, name, patterns[Math.min(current.workbook.offers.length, 2)]!, columnId);
    }
    const vendorId = id<"vendor">(), offerId = id<"offer">();
    return includeNewVendorComponentTotals(prepareLegacySheet(addOffer(addVendor(current, { id: vendorId, analysisId: current.analysisId, name }),
      { id: offerId, analysisId: current.analysisId, vendorId, label: name, values: [] })), offerId);
  }

  function handleProfileChange(profile: Profile) {
    if (!snapshot) return;
    apply(() => changeSheetProfile(snapshot, profile));
  }

  function handleSelectOffer(selectionId: string) {
    if (snapshot?.workbook && actor) {
      apply(() => {
        const next = selectSheetOffer(snapshot, parseStableId<"offer">(selectionId), actor);
        const source = next.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(cell => ({ cell, label: t.rows.find(row => row.id === cell.rowId)?.label })))).find(field =>
          field.cell.scope === next.activeProfile && next.worksheets.find(w => w.stage === "AHS")?.tables.some(t => t.cells.some(cell => cell.id === field.cell.id)) && field.label === "Sumber");
        return source?.cell.source.kind === "INPUT" ? editSheetInput(next, source.cell, { kind: "TEXT", text: vendorDisplayName(selectionId) }) : next;
      });
    } else if (onSelectOffer) {
      onSelectOffer(selectionId, vendorDisplayName(selectionId));
    }
  }

  function vendorDropdown() {
    const selectedOffer = snapshot?.analysis.offers.find(r => r.id === snapshot.selectedOfferId);
    return <select className="conversion-vendor-select" aria-label="Vendor untuk Konversi" value={selectedOffer?.id ?? ""}
      disabled={disabled || !snapshot || (!!snapshot.workbook && !actor)} onChange={event => {
        const activeOffer = snapshot?.analysis.offers.find(r => r.id === event.target.value);
        if (activeOffer) handleSelectOffer(activeOffer.id);
      }}>
      <option value="" disabled>Pilih vendor</option>
      {snapshot?.analysis.offers.map(offer => <option key={offer.id} value={offer.id}
        disabled={!snapshot.analysis.offers.some(r => r.id === offer.id)}>
        {vendorDisplayName(offer.id)}
      </option>)}
    </select>;
  }

  function vendorDisplayName(offerId: string) {
    const offer = snapshot?.analysis.offers.find(o => o.id === offerId);
    const column = snapshot?.workbook?.offers.find(o => o.offerId === offerId);
    const header = snapshot?.worksheets.filter(w => w.stage === "EVALUASI_VENDOR").flatMap(w => w.tables.flatMap(t =>
      t.cells.filter(c => column ? c.id === column.nameCellId : t.rows.some(r => r.id === c.rowId && r.label.endsWith(`|vendor:${offerId}:Nama vendor`)))))[0];
    const result = header && results.get(header.id);
    return result?.status === "TEXT" && result.text.trim() ? result.text.trim()
      : snapshot?.analysis.vendors.find(v => v.id === offer?.vendorId)?.name || offer?.label || "Vendor";
  }

  // Value formatting
  function cellValue(cell: CellSnapshot | undefined, format: "number" | "percentage" | "fixed-number" = "number") {
    if (!cell) return "";
    const result = results.get(cell.id);
    if (format === "number" && cell.scope === "INU" && (result?.writer === "INU_SOLVER" || cell.id === snapshot?.profiles.INU.hppBase.cellId)) format = "fixed-number";
    const title = result && "text" in result ? result.text : cell.source.kind === "INPUT" && cell.source.input.kind === "TEXT" ? cell.source.input.text : "";
    if (codes.get(cell.id) === "EV!B3" && title.trim().toUpperCase() === "EVALUASI HARGA VENDOR") return "EVALUASI VENDOR";
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
  const materialCell = allTables.flatMap(table => table.cells).find(cell => codes.get(cell.id) === "EV!D5");
  const volumeCell = ahsVolumeSource(snapshot, snapshot.activeProfile);
  const printTitle = workbookPrintTitle({
    projectName: snapshot.project.name, analysisName: snapshot.analysis.analysis.name,
    volume: volumeCell && !cellError(volumeCell) ? cellValue(volumeCell) : "",
    material: materialCell && !cellError(materialCell) ? cellValue(materialCell) : "",
  });
  const currentAhsGroups = ahsGroups(snapshot), incomeAhsGroups = ahsGroups(snapshot, snapshot.activeProfile, "PENDAPATAN");
  const addedAhsItems = [...currentAhsGroups, ...incomeAhsGroups].flatMap(g => g.items.filter(item => !item.builtin));
  const extraFields = (snapshot.ahsFields ?? []).filter(f => f.profile === snapshot.activeProfile);
  const fieldRows = new Map(extraFields.map(f => [ahsCell(snapshot, f.valueCellId)!.rowId, f]));
  const incomeRows = new Set(incomeAhsGroups.flatMap(g => g.items.filter(item => !item.builtin).map(item => ahsCell(snapshot, item.priceCellId)!.rowId)));
  const addedAhsRows = new Set(addedAhsItems.map(item => ahsCell(snapshot, item.priceCellId)?.rowId));
  const addedAhsCells = new Set([...addedAhsItems.flatMap(item => [item.priceCellId, item.volumeCellId, item.totalCellId, item.labelCellId]),
    ...extraFields.flatMap(f => [f.labelCellId, f.valueCellId])]);
  const ahsActionSections: readonly AhsSection[] = ["INFORMASI", "PENDAPATAN", "BIAYA", "LABA"];
  const ahsActions = () => <AhsActions key={snapshot.analysisId + snapshot.activeProfile} section="INFORMASI" sections={ahsActionSections} snapshot={snapshot} configuration={configuration}
    disabled={disabled} error={toolbarError} onApply={apply} addButtonRef={button => { ahsAddButtonsRef.current["INFORMASI"] = button; }} />;
  const fieldRowsFor = (section: "INFORMASI" | "LABA") => ahsFields(snapshot, section).map(field => <tr key={field.valueCellId} className={section === "INFORMASI" ? "ahs-meta" : "profit-row"}>
    <th colSpan={section === "INFORMASI" ? 3 : 5}>{worksheetCellEditor(ahsCell(snapshot, field.labelCellId)!, "Nama uraian AHS")}</th>
    <td colSpan={section === "INFORMASI" ? 3 : 1}>{worksheetCellEditor(ahsCell(snapshot, field.valueCellId)!, ahsLabel(snapshot, field), field.valueType === "PERCENT" ? "percentage" : "number")}</td>
  </tr>);
  const selectedVendorOfferId = snapshot.analysis.offers.find(activeOffer => activeOffer.id === snapshot.selectedOfferId)?.id;
  const selectedVendorComponents = selectedVendorOfferId ? vendorComponents(snapshot, selectedVendorOfferId) : [];
  const componentLabel = (component: (typeof selectedVendorComponents)[number]) => component.labelCell ? cellValue(component.labelCell) : component.role;
  const removableComponents = removableVendorComponents(snapshot);
  const vendorActions = <details className="vendor-table-actions vendor-menu-actions" ref={vendorMenuRef} onClick={event => event.stopPropagation()}
    onToggle={event => { setVendorMenuOpen(event.currentTarget.open); if (event.currentTarget.open) requestAnimationFrame(() => {
      const menu = vendorMenuRef.current;
      if (menu?.open && document.activeElement === menu.querySelector("summary")) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }); }}
    onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; focusVendorMenu(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.currentTarget.open = true;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" || (current < 0 && event.key === "ArrowUp") ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }}>
    <summary aria-label="Aksi Evaluasi Vendor" aria-haspopup="menu" title="Aksi Evaluasi Vendor">
      <MenuToggleIcon open={vendorMenuOpen} duration={500} aria-hidden="true" />
    </summary>
    <div role="menu" aria-label="Aksi Evaluasi Vendor">
      <button type="button" role="menuitem" disabled={disabled} onClick={() => menuAction(openAddComponentDialog)}>Tambah uraian</button>
      <button type="button" role="menuitem" className="menu-danger" disabled={disabled || !configuration || !removableComponents.length} onClick={() => menuAction(openRemoveComponentDialog)}>Hapus uraian</button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => menuAction(handleAddVendor)}>Tambah vendor</button>
      <button type="button" role="menuitem" className="menu-danger" disabled={disabled || snapshot.analysis.offers.length <= 3} title={snapshot.analysis.offers.length <= 3 ? "Minimal 3 vendor" : undefined} onClick={() => menuAction(openRemoveVendorDialog)}>Hapus vendor</button>
    </div>
  </details>;
  const removeComponentDialog = <dialog ref={removeComponentDialogRef} onClose={focusVendorMenu} className="vendor-delete-dialog" aria-labelledby="vendor-component-delete-title">
    <form onSubmit={handleRemoveComponent}>
      <header><div><h2 id="vendor-component-delete-title">Hapus uraian</h2><p>Uraian dan nilainya akan dihapus dari seluruh vendor serta Konversi.</p></div>
        <button type="button" className="dialog-close" aria-label="Tutup" onClick={() => removeComponentDialogRef.current?.close()}>×</button></header>
      <div className="vendor-delete-list">{removableComponents.map(component => <label key={component.labelCell!.id} className={componentToRemove === component.labelCell!.id ? "is-selected" : undefined}>
        <input type="radio" name="componentToRemove" value={component.labelCell!.id} checked={componentToRemove === component.labelCell!.id} onChange={() => setComponentToRemove(component.labelCell!.id)} />
        <strong>{componentLabel(component) || "Uraian tanpa nama"}</strong>
      </label>)}</div>
      {toolbarError && <p role="alert" className="vendor-delete-error">{toolbarError}</p>}
      <footer><button type="button" onClick={() => removeComponentDialogRef.current?.close()}>Batal</button>
        <button type="submit" className="vendor-delete-confirm" disabled={disabled || !configuration || !componentToRemove}>Hapus uraian</button></footer>
    </form>
  </dialog>;
  const removeVendorDialog = <dialog ref={removeVendorDialogRef} onClose={focusVendorMenu} className="vendor-delete-dialog" aria-labelledby="vendor-delete-title">
    <form onSubmit={event => { event.preventDefault(); handleRemoveVendor(); }}>
      <header><div><h2 id="vendor-delete-title">Hapus vendor</h2><p>Pilih vendor dari Evaluasi Vendor. Minimal 3 vendor tetap tersedia.</p></div>
        <button type="button" className="dialog-close" aria-label="Tutup" onClick={() => removeVendorDialogRef.current?.close()}>×</button></header>
      <div className="vendor-delete-list">
        {snapshot.analysis.offers.map((offer, index) => {
          const name = vendorDisplayName(offer.id);
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
  const addComponentDialog = <dialog ref={addComponentDialogRef} onClose={focusVendorMenu} className="vendor-delete-dialog" aria-labelledby="vendor-component-title">
    <form onSubmit={handleAddComponent}>
      <header><div><h2 id="vendor-component-title">Tambah uraian</h2><p>Nilai otomatis masuk ke total setiap vendor.</p></div>
        <button type="button" className="dialog-close" aria-label="Tutup" onClick={() => addComponentDialogRef.current?.close()}>×</button></header>
      <label htmlFor="vendor-component-name">Nama uraian</label>
      <input id="vendor-component-name" name="componentName" value={newComponentName} onChange={event => setNewComponentName(event.target.value)} required autoFocus placeholder="Contoh: Biaya administrasi" />
      {toolbarError && <p role="alert" className="vendor-delete-error">{toolbarError}</p>}
      <footer><button type="button" onClick={() => addComponentDialogRef.current?.close()}>Batal</button>
        <button type="submit" className="vendor-component-confirm" disabled={disabled || !newComponentName.trim()}>Tambah uraian</button></footer>
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
    const selectedId = snapshot.selectedOfferId ?? snapshot.workbook.selections[snapshot.activeProfile];
    const selectedOfferId = snapshot.analysis.offers.find(activeOffer => activeOffer.id === selectedId)?.id;
    const selectedVendorColumnId = offers.find(offer => offer.offerId === selectedOfferId)?.columnId;
    const sheetStyle = { "--vendor-columns": vendorColumnsCount } as CSSProperties;
    const overviewValue = (key: string) => cellValue(allTables.flatMap(t => t.cells).find(c => c.id === binding(snapshot, snapshot.activeProfile, key)));
    const hppContext = "Belum ditinjau";

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
              if (stage === "KONVERSI_JAGAD" && rowMeta?.label.startsWith("vendor-extra:") && !table.cells.some(cell => cell.rowId === rowId &&
                snapshot.mappings.some(mapping => mapping.targetCellId === cell.id && mapping.sourceComponent.startsWith("vendor-live:")))) return null;

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
                if (fieldRows.has(rowId)) trClass = fieldRows.get(rowId)!.section === "INFORMASI" ? "ahs-meta" : "profit-row";
                else if (addedAhsRows.has(rowId)) trClass = incomeRows.has(rowId) ? "income-row" : "cost-row";
                else if (rowNum === 3) trClass = "ahs-title";
                else if (rowNum >= 4 && rowNum <= 7) trClass = "ahs-meta";
                else if (rowNum === 8) trClass = "ahs-meta ahs-include";
                else if (rowNum >= 9 && rowNum <= 13) trClass = rowNum <= 10 ? "income-row income-total" : "income-row";
                else if (rowNum >= 14 && rowNum <= 33) trClass = rowNum <= 15 ? "cost-row cost-total" : "cost-row";
                else if (rowNum >= 34 && rowNum <= 38) trClass = `profit-row${rowNum === 36 ? " profit-net" : rowNum === 38 ? " profit-percent" : ""}`;
                else if (rowNum === 39) trClass = "ahs-notes";
              }

              const lastCellIndex = row.findLastIndex(entry => !!entry?.cell);
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
                    if (stage === "AHS" && colMeta?.label === "G" && ((rowNum >= 11 && rowNum <= 13) || (rowNum >= 16 && rowNum <= 33) || addedAhsRows.has(rowId))) cellClasses.push("category");
                    if (stage === "AHS" && colMeta?.label === "H") cellClasses.push("cost-description");
                    if (stage === "AHS" && (colMeta?.label === "I" || colMeta?.label === "K") && ((rowNum >= 14 && rowNum <= 33) || addedAhsRows.has(rowId))) {
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
                    const sourceMapping = stage === "KONVERSI_JAGAD" && colIndex === 0 ? snapshot.mappings.find(mapping => mapping.sourceComponent.startsWith("vendor-live:") &&
                      table.cells.some(target => target.id === mapping.targetCellId && target.rowId === rowId)) : undefined;
                    const sourceComponent = selectedVendorComponents.find(component => component.source.id === sourceMapping?.sourceCellId);
                    if (stage === "EVALUASI_VENDOR" || isAhsVolumeCell(snapshot, cell) || (stage === "AHS" && addedAhsCells.has(cell.id))) {
                      displayContent = worksheetCellEditor(cell, stage === "EVALUASI_VENDOR" ? `Evaluasi Vendor · ${cellAddress}` : `Lembar AHS · ${isAhsVolumeCell(snapshot, cell) ? "Volume · " : ""}${cellAddress}`, fieldRows.get(rowId)?.valueCellId === cell.id && fieldRows.get(rowId)?.valueType === "PERCENT" ? "percentage" : "number");
                    } else if (sourceComponent) {
                      displayContent = <span className="sheet-result">{componentLabel(sourceComponent)}</span>;
                    } else if (stage === "KONVERSI_JAGAD" && cell.id === binding(snapshot, snapshot.activeProfile, "supplierName")) {
                      displayContent = <>{vendorDropdown()}<span className="cell-print-value vendor-print-name">{cellValue(cell)}</span></>;
                    } else if (stage === "KONVERSI_JAGAD" && isINU && meta?.address === "D30" && run?.solver?.cost) {
                      displayContent = <span className="sheet-result" title={run.solver.cost}>{sheetNumberFixed(run.solver.cost)}</span>;
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
                        {colMeta?.label === "I" && stage === "AHS" && ((rowNum >= 14 && rowNum <= 33) || addedAhsRows.has(rowId)) && <span>Rp</span>}
                        {trClass === "vendor-title" && colIndex === row.findIndex(item => item?.cell) ?
                          <div className="vendor-title-layout"><div className="vendor-title-content">{displayContent}</div>{vendorActions}</div>
                          : stage === "AHS" && rowNum === 3 && colIndex === lastCellIndex
                            ? <div className="vendor-title-layout"><div className="vendor-title-content">{displayContent}</div>{ahsActions()}</div>
                            : displayContent}
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
        {addComponentDialog}
        {removeComponentDialog}
        <div ref={sheetRef} className="procurement-sheet" style={sheetStyle} data-testid="procurement-sheet" data-print-title={printTitle}>
          <header className="sheet-overview">
            <div><p className="eyebrow">PROCUREMENT WORKSPACE · {isINU ? "INU" : "SOLAR BAWAH"}</p>
              <h2>Evaluasi Vendor & Analisis Harga Satuan</h2>
              <p>{snapshot.project.name} / {snapshot.analysis.analysis.name}</p></div>
            <dl className="metrics">
              <div><dt>Volume (L)</dt><dd>{overviewValue("volume")}</dd></div>
              <div><dt>Harga jual (Rp/L)</dt><dd>{overviewValue("sale")}</dd></div>
              <div><dt>Laba bersih (Rp)</dt><dd>{overviewValue("profit")}</dd></div>
            </dl>
            <button type="button" className="print-button" disabled={disabled || isPreparingPrint} onClick={() => void handlePrint()}>{isPreparingPrint ? "Menyiapkan…" : "Cetak ke PDF"}</button>
          </header>
          {run?.provisional && <p className="sheet-assumptions">Asumsi nol sementara: {run.provisional.assumedZeroCellIds.length
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
                  readOnly={selectedVolumeFollower}
                  onChange={e => { setIsEditingFormula(true); setFormulaExpression(e.target.value); onEditing?.(); }}
                  onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelFormula(); } }}
                  placeholder={selectedCell ? "Ketik formula atau klik sel lain untuk menyisipkan referensi" : "Pilih sel pada tabel"}
                  disabled={disabled || (!selectedCell && !legacyTarget)}
                />
                <button className="toolbar-button toolbar-button-primary" type="submit" disabled={disabled || selectedVolumeFollower || (!selectedCell && !legacyTarget)}>Terapkan</button>
                {isEditingFormula && <button className="toolbar-button" type="button" onClick={cancelFormula}>Batal edit</button>}
              </form>
              {onSave && <button className="toolbar-button toolbar-button-save" type="button" aria-busy={saving} disabled={disabled || saving} onClick={onSave}>{saving ? "Menyimpan…" : "Simpan perubahan"}</button>}
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
                <button type="button" disabled={disabled || selectedVolumeFollower || !selectedCell} onClick={handleClearCell}>Kosongkan sel</button>
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
              <div className="vendor-table-container">
              {vendorTables.map(table => renderTableGrid(table, "EVALUASI_VENDOR", "vendor-sheet", "Evaluasi Vendor"))}
              </div>
            </section>

            {/* Konversi section with the required INU toggle */}
            <section className="sheet-card conversion-card" aria-label="Satuan Jagad">
            <div className="sheet-section-title"><h2>Konversi Satuan Jagad</h2></div>
            <div className="conversion-control-bar">
              <label className="profile-picker">Profil Konversi
                <select aria-label="Profil Konversi" value={snapshot.activeProfile} disabled={disabled}
                  onChange={event => handleProfileChange(event.target.value as Profile)}>
                  <option value="SOLAR_BAWAH">SKP</option><option value="INU">INU</option>
                </select>
              </label>
              {isINU && run?.solver && (
                <span className="solver-status" aria-live="polite">
                  Biaya: <strong>{run.solver.cost === null ? "—" : sheetNumberFixed(run.solver.cost)}</strong> · Profit MUE: <strong>{run.solver.profit === null ? "—" : sheetNumberFixed(run.solver.profit)}</strong> ({run.solver.status})
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
    if (cell && (stage === "EVALUASI_VENDOR" || (snapshot && isAhsVolumeCell(snapshot, cell)))) content = worksheetCellEditor(cell, `${stage === "EVALUASI_VENDOR" ? "Evaluasi Vendor" : "Lembar AHS"} · ${label}`);
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

  const selected = snapshot?.analysis.offers.find(r => r.id === snapshot.selectedOfferId);
  const legacyOffers = snapshot?.analysis.offers.map(offer => ({ offer,
    vendor: { ...snapshot.analysis.vendors.find(v => v.id === offer.vendorId)!, name: vendorDisplayName(offer.id) } })) ?? [];
  const legacyVendorColumns = Math.max(3, legacyOffers.length);
  const legacyComponentRows = legacyOffers[0] ? vendorComponents(snapshot, legacyOffers[0].offer.id).filter(component => component.role !== "TOTAL") : [];
  const header = (label: string, className: string) => <tr key={label} className={className}>
    <th colSpan={5}>{label}</th>
    <td>{legacySlot("AHS", label)}</td>
  </tr>;
  const conversionColumns = ["Harga INU", "Biaya"];
  const conversionRows = selectedVendorComponents.length ? selectedVendorComponents.map(component => ({
    key: vendorComponentRoles.some(role => role === component.role) ? component.role === "TOTAL" ? "ALL IN" : component.role : `vendor-extra:${component.labelCell?.id ?? component.source.id}`,
    label: componentLabel(component),
  })) : vendorComponentRoles.map(role => ({ key: role === "TOTAL" ? "ALL IN" : role, label: role }));
  const sheetStyle = { "--vendor-columns": legacyVendorColumns } as CSSProperties;
  const legacyOverviewValue = (stage: Stage, label: string, format: "number" | "percentage" = "number") =>
    cellValue(findLegacy(stage, label), format);

  return (
    <div className="sheet-viewport" aria-label="Lembar procurement" tabIndex={0}>
      {removeVendorDialog}
      {addComponentDialog}
      {removeComponentDialog}
      <div ref={sheetRef} className="procurement-sheet" style={sheetStyle} data-testid="procurement-sheet" data-print-title={printTitle}>
        <header className="sheet-overview">
          <div><p className="eyebrow">PROCUREMENT WORKSPACE · {isINU ? "INU" : "SOLAR BAWAH"}</p>
            <h2>Evaluasi Vendor &amp; Analisis Harga Satuan</h2>
            <p>{snapshot.project.name} / {snapshot.analysis.analysis.name}</p></div>
          <dl className="metrics">
            {analysisStatus && onAnalysisStatusChange && <div><dt>Status</dt><dd><select aria-label="Status analisis" value={analysisStatus} disabled={disabled} onChange={event => onAnalysisStatusChange(event.currentTarget.value as AnalysisStatus)}>{ANALYSIS_STATUSES.map(status => <option key={status} value={status}>{analysisStatusLabel[status]}</option>)}</select></dd></div>}
            <div><dt>Volume (L)</dt><dd>{legacyOverviewValue("AHS", "Harga Jual · Harga Dasar · Volume")}</dd></div>
            <div><dt>Harga jual (Rp/L)</dt><dd>{legacyOverviewValue("AHS", "Harga Jual · Harga Dasar")}</dd></div>
            <div><dt>Laba bersih (Rp)</dt><dd>{legacyOverviewValue("AHS", "LABA BERSIH")}</dd></div>
          </dl>
          <button type="button" className="print-button" disabled={disabled || isPreparingPrint} onClick={() => void handlePrint()}>{isPreparingPrint ? "Menyiapkan…" : "Cetak ke PDF"}</button>
        </header>
        <div className="sheet-canvas-toolbar">
          <div className="toolbar-row formula-row">
            <span className="editor-cell-address" aria-label="Alamat sel">{activeCellAddress}</span>
            <form className="formula-bar-form" onSubmit={handleApplyFormula}>
              <input ref={formulaInputRef} aria-label="Formula sel terpilih" value={formulaExpression} data-editing={isEditingFormula}
                readOnly={selectedVolumeFollower}
                disabled={disabled || (!selectedCell && !legacyTarget)}
                onChange={event => { setIsEditingFormula(true); setFormulaExpression(event.target.value); onEditing?.(); }}
                onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelFormula(); } }}
                placeholder="Ketik = lalu klik sel sumber" />
              <button className="toolbar-button toolbar-button-primary" disabled={disabled || selectedVolumeFollower || (!selectedCell && !legacyTarget)}>Terapkan</button>
              {isEditingFormula && <button className="toolbar-button" type="button" onClick={cancelFormula}>Batal edit</button>}
            </form>
            {onSave && <button className="toolbar-button toolbar-button-save" type="button" aria-busy={saving} disabled={disabled || saving} onClick={onSave}>{saving ? "Menyimpan…" : "Simpan perubahan"}</button>}
          </div>
          {formulaMeaning && <p className="formula-meaning">Arti rumus: {formulaMeaning}</p>}
          {toolbarError && <div className="toolbar-error" role="alert">{toolbarError}</div>}
          {selectedDiagnostic && <div className="toolbar-error" role="status">{selectedDiagnostic}</div>}
        </div>
        <div className="sheet-left">
          <div className="vendor-table-container">
          <table className="vendor-sheet" aria-label="Evaluasi Vendor">
            <colgroup>{Array.from({ length: legacyVendorColumns + 1 }, (_, i) => <col key={i} className={i > 0 && selected && selected.id !== legacyOffers[i - 1]?.offer.id ? "vendor-unselected" : undefined} />)}</colgroup>
            <thead><tr className="vendor-title"><th colSpan={legacyVendorColumns + 1}><div className="vendor-title-layout"><div className="vendor-title-content">{vendorSlot("B3", "Judul")}</div>{vendorActions}</div></th></tr></thead>
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
                <th key={entry.offer.id} className={selected && selected.id !== entry.offer.id ? "vendor-unselected" : undefined}>{vendorSlot(`${vendorColumn(index)}9`, `Nama vendor ${index + 1}`)}</th>
              ))}</tr>
              {legacyComponentRows.map(component => {
                const label = componentLabel(component);
                return <tr key={component.labelCell?.id ?? component.source.id}><td>{component.labelCell ? legacySlot("EVALUASI_VENDOR", `Uraian ${label}`, "TEXT", component.labelCell) : label}</td>{legacyOffers.map(entry => {
                  const value = vendorComponents(snapshot, entry.offer.id).find(other => component.labelCell ? other.labelCell?.id === component.labelCell.id : other.role === component.role)?.source;
                  return <td className={`sheet-number${selected && selected.id !== entry.offer.id ? " vendor-unselected" : ""}`} key={entry.offer.id}>
                    {value ? legacySlot("EVALUASI_VENDOR", `${entry.vendor.name} · ${label}`, "NUMERIC_TEXT", value) : ""}</td>;
                })}</tr>;
              })}
              <tr className="vendor-total"><td>{vendorSlot("B17", "Label TOTAL")}</td>{legacyOffers.map((entry, index) => (
                <td className={selected && selected.id !== entry.offer.id ? "vendor-unselected" : undefined} key={entry.offer.id}>{vendorSlot(`${vendorColumn(index)}17`, `${entry.vendor.name} · TOTAL`)}</td>
              ))}</tr>
              <tr className="vendor-notes"><td>{vendorSlot("B18", "Label Notes")}</td>{legacyOffers.map((entry, index) => (
                <td className={selected && selected.id !== entry.offer.id ? "vendor-unselected" : undefined} key={entry.offer.id}>{vendorSlot(`${vendorColumn(index)}18`, `${entry.vendor.name} · Notes`)}</td>
              ))}</tr>
            </tbody>
          </table>
          </div>

          <div className="conversion-control-bar">
            <label className="profile-picker">Profil Konversi
              <select aria-label="Profil Konversi" value={snapshot?.activeProfile ?? "SOLAR_BAWAH"} disabled={disabled}
                onChange={event => handleProfileChange(event.target.value as Profile)}>
                <option value="SOLAR_BAWAH">SKP</option><option value="INU">INU</option>
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
              <tr className="conversion-meta"><th>Nama {snapshot?.activeProfile === "SOLAR_BAWAH" ? "Solar" : "INU"} <span>:</span></th><td colSpan={2}>{vendorDropdown()}<span className="cell-print-value vendor-print-name">{selected ? legacyOffers.find(o => o.offer.id === selected.id)?.vendor.name : ""}</span></td></tr>
              <tr className="sheet-spacer"><td colSpan={3} /></tr>
              <tr className="conversion-columns"><th>Uraian</th><th>{snapshot?.activeProfile === "SOLAR_BAWAH" ? "Harga Solar" : "Harga INU"}</th><th>Biaya</th></tr>
              {conversionRows.map(row => (
                <tr key={row.key} className={row.key === "ALL IN" ? "conversion-total" : ""}>
                  <th>{row.label}</th>
                  {conversionColumns.map(column => <td key={column}>{legacySlot("KONVERSI_JAGAD", `${column} · ${row.key}`)}</td>)}
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

        <div className="sheet-table-scroll">
        <table className="ahs-sheet" aria-label="Analisis Harga Satuan AHS">
          <colgroup>{Array.from({ length: 6 }, (_, i) => <col key={i} />)}</colgroup>
          <thead><tr className="ahs-title"><th colSpan={6}><div className="vendor-title-layout"><div className="vendor-title-content">ANALISIS HARGA SATUAN (AHS)</div>{ahsActions()}</div></th></tr></thead>
          <tbody>
            {[["Tgl Analisis (Rn)", "Sumber"], ["Marketing", "Lokasi"], ["Pembayaran", "Dokumen"], ["Harga Keekonomian", "Diskon"]].map(pair => (
              <tr className="ahs-meta" key={pair[0]}>
                {pair.map(label => <Fragment key={label}><th>{label}</th><td colSpan={2}>{legacySlot("AHS", label, "TEXT")}</td></Fragment>)}
              </tr>
            ))}
            {fieldRowsFor("INFORMASI")}
            <tr className="ahs-meta ahs-include"><th colSpan={3}>HARGA INCLUDE</th><td colSpan={3}>{legacySlot("AHS", "Harga Include")}</td></tr>
            {header("TOTAL PENDAPATAN", "income-row")}{header("HARGA JUAL SETELAH PAJAK", "income-row")}
            {incomeAhsGroups.flatMap(group => group.items.map((item, index) => (
              <tr className="income-row" key={item.priceCellId}>
                {index === 0 && <th rowSpan={group.items.length} className="category">{ahsLabel(snapshot, group)}</th>}
                <td className="cost-description">{ahsLabel(snapshot, item)}</td>
                <td>{legacySlot("AHS", `${group.name} · ${item.name}`, "NUMERIC_TEXT", ahsCell(snapshot, item.priceCellId))}</td>
                <td>{legacySlot("AHS", `${group.name} · ${item.name} · Volume`, "NUMERIC_TEXT", ahsCell(snapshot, item.volumeCellId))}</td>
                <td colSpan={2}>{legacySlot("AHS", `${group.name} · ${item.name} · Total`, "NUMERIC_TEXT", ahsCell(snapshot, item.totalCellId))}</td>
              </tr>
            )))}
            {header("TOTAL BIAYA", "cost-row")}{header("BIAYA PER LITER", "cost-row")}
            {currentAhsGroups.flatMap(group => group.items.map((item, index) => (
              <tr className="cost-row" key={item.priceCellId}>
                {index === 0 && <th rowSpan={group.items.length} className="category">{ahsLabel(snapshot, group)}</th>}
                <td className="cost-description" title={ahsLabel(snapshot, item)}>{item.labelCellId ? worksheetCellEditor(ahsCell(snapshot, item.labelCellId)!, "Nama uraian AHS") : item.name}</td>
                <td className="currency-cell"><span>Rp</span>{legacySlot("AHS", `${group.name} · ${item.name}`, "NUMERIC_TEXT", ahsCell(snapshot, item.priceCellId))}</td>
                <td>{legacySlot("AHS", `${group.name} · ${item.name} · Volume`, "NUMERIC_TEXT", ahsCell(snapshot, item.volumeCellId))}</td>
                <td colSpan={2} className="currency-cell"><span>Rp</span>{legacySlot("AHS", `${group.name} · ${item.name} · Total`, "NUMERIC_TEXT", ahsCell(snapshot, item.totalCellId))}</td>
              </tr>
            )))}
            {summaryRows.map(label => header(label, "profit-row"))}
            {fieldRowsFor("LABA")}
            <tr className="ahs-notes"><td colSpan={6}>Notes{legacySlot("AHS", "Notes", "TEXT")}</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
