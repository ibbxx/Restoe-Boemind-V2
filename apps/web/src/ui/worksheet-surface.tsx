import { Fragment } from "react";
import type { CSSProperties } from "react";
import type { CellSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "../domain/contracts.ts";
import type { EngineRun } from "../engine/contracts.ts";

type Stage = WorksheetSnapshot["stage"];
interface SurfaceProps {
  snapshot: WorkbookSnapshot | null;
  run: EngineRun | null;
  disabled: boolean;
  onInput: (stage: Stage, label: string, value: string, kind: "TEXT" | "NUMERIC_TEXT", cell: CellSnapshot | undefined) => void;
  onSelectOffer: (revisionId: string) => void;
}
const vendorRows = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "BPH"];
const conversionRows = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN", "ALL IN"];
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

// Display formatting only: grouping the original decimal string never rounds or converts money through Number.
export function sheetNumber(text: string, decimals = 0): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return text;
  const fraction = (match[3] ?? "").padEnd(decimals, "0");
  return match[1] + match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (fraction ? "," + fraction : "");
}

export function WorksheetSurface({ snapshot, run, disabled, onInput, onSelectOffer }: SurfaceProps) {
  const fields = snapshot?.worksheets.flatMap(w => w.tables.flatMap(t => t.rowOrder.flatMap(rowId => t.columnOrder.flatMap(columnId => {
    const cell = t.cells.find(c => c.rowId === rowId && c.columnId === columnId);
    return cell && (cell.scope === "SHARED" || cell.scope === snapshot.activeProfile)
      ? [{ cell, label: t.rows.find(r => r.id === rowId)!.label, stage: w.stage }] : [];
  })))) ?? [];
  const used = new Set<string>();
  function find(stage: Stage, label: string) {
    const matches = fields.filter(f => f.stage === stage && normalized(f.label) === normalized(label));
    // Ambiguous row labels are shown separately below, never silently bound to a financial slot.
    return matches.length === 1 ? matches[0]!.cell : undefined;
  }
  function value(cell: CellSnapshot | undefined) {
    if (!cell) return "—";
    const result = run?.results.find(r => r.cellId === cell.id);
    if (result) return "value" in result ? sheetNumber(result.value) : "text" in result ? result.text : result.status;
    return cell.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? sheetNumber(cell.source.input.text) : "—";
  }
  function slot(stage: Stage, label: string, kind: "TEXT" | "NUMERIC_TEXT" = "NUMERIC_TEXT", explicit?: CellSnapshot) {
    const cell = explicit ?? find(stage, label);
    if (cell) used.add(cell.id);
    const pinned = cell && snapshot?.mappings.some(m => m.sourceCellId === cell.id && m.sourceComponent.startsWith("offer-value:"));
    if (cell && (cell.source.kind !== "INPUT" || pinned)) return <span className="sheet-result" title={value(cell)}>{value(cell)}</span>;
    const raw = cell?.source.kind === "INPUT" && cell.source.input.kind !== "UNSET" ? cell.source.input.text : "";
    return <input key={(cell?.id ?? label) + ":" + raw} className="sheet-input" aria-label={`Lembar ${stage} · ${label}`}
      defaultValue={raw} placeholder="—" disabled={disabled || !snapshot} inputMode={kind === "TEXT" ? "text" : "decimal"}
      onBlur={event => { if (event.target.value !== raw) onInput(stage, label, event.target.value, kind, cell); }} />;
  }
  const selected = snapshot?.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId);
  const offers = snapshot?.analysis.offers.map(offer => {
    const revisions = snapshot.analysis.offerRevisions.filter(r => r.offerId === offer.id);
    const latest = revisions.reduce<typeof selected>((latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
    return { offer, revision: selected?.offerId === offer.id ? selected : latest,
      vendor: snapshot.analysis.vendors.find(v => v.id === offer.vendorId)! };
  }) ?? [];
  const vendorColumns = Math.max(3, offers.length);
  const extraVendorRows = [...new Set(offers.flatMap(o => o.revision?.values.map(v => v.label) ?? []))]
    .filter(label => !vendorRows.some(row => normalized(row) === normalized(label)));
  const hpp = fields.find(f => f.cell.id === snapshot?.profiles[snapshot.activeProfile].hppBase.cellId)?.cell;
  const header = (label: string, className: string) => <tr className={className}><th colSpan={5}>{label}</th><td>{slot("AHS", label)}</td></tr>;
  const conversionColumns = ["Harga INU", "Biaya"];
  const sheetStyle = { "--vendor-columns": vendorColumns } as CSSProperties;

  return <div className="sheet-viewport" aria-label="Lembar procurement" tabIndex={0}>
    <div className="procurement-sheet" style={sheetStyle} data-testid="procurement-sheet">
      <div className="sheet-left">
        <table className="vendor-sheet" aria-label="Evaluasi harga vendor">
          <colgroup>{Array.from({ length: vendorColumns + 1 }, (_, i) => <col key={i} />)}</colgroup>
          <thead><tr className="vendor-title"><th colSpan={vendorColumns + 1}>EVALUASI HARGA VENDOR</th></tr></thead>
          <tbody>
            <tr className="sheet-spacer"><td colSpan={vendorColumns + 1} /></tr>
            {["Pekerjaan / Material", "Customer", "Lokasi"].map(label => <tr className="vendor-meta" key={label}>
              <td colSpan={2}><span>{label}</span><span>:</span></td><td colSpan={vendorColumns - 1}>{slot("EVALUASI_VENDOR", label, "TEXT")}</td>
            </tr>)}
            <tr className="sheet-spacer"><td colSpan={vendorColumns + 1} /></tr>
            <tr><th>Uraian</th>{Array.from({ length: vendorColumns }, (_, i) => {
              const entry = offers[i]; return <th key={entry?.offer.id ?? i}>{entry ? <button className="vendor-choice" disabled={disabled || !entry.revision}
                aria-pressed={entry.revision?.id === selected?.id} title={entry.offer.label + " · revisi " + (entry.revision?.revisionNumber ?? "belum ada")}
                onClick={() => { if (entry.revision) onSelectOffer(entry.revision.id); }}>{entry.vendor.name}</button> : `Vendor ${i + 1}`}</th>;
            })}</tr>
            {[...vendorRows, ...extraVendorRows].map(label => <tr key={label}><td>{label}</td>{Array.from({ length: vendorColumns }, (_, i) => {
              const input = offers[i]?.revision?.values.find(v => normalized(v.label) === normalized(label))?.input;
              return <td className="sheet-number" key={i}>{input && input.kind !== "UNSET" ? sheetNumber(input.text, 2) : "—"}</td>;
            })}</tr>)}
            <tr className="vendor-total"><td />{Array.from({ length: vendorColumns }, (_, i) => <td key={i}>—</td>)}</tr>
            <tr className="vendor-notes"><td>Note :</td>{Array.from({ length: vendorColumns }, (_, i) => <td key={i} />)}</tr>
          </tbody>
        </table>

        <table className="conversion-sheet" aria-label="Konversi Satuan INU">
          <colgroup><col /><col /><col /></colgroup>
          <thead><tr><th colSpan={3}>Konversi Satuan {snapshot?.activeProfile === "SOLAR_BAWAH" ? "Solar Bawah" : "INU"}</th></tr></thead>
          <tbody>
            <tr className="sheet-spacer"><td colSpan={3} /></tr>
            <tr className="conversion-period"><th colSpan={3}>{slot("KONVERSI_JAGAD", "Periode", "TEXT")}</th></tr>
            <tr className="conversion-meta"><th>Lokasi <span>:</span></th><td colSpan={2}>{slot("KONVERSI_JAGAD", "Lokasi", "TEXT")}</td></tr>
            <tr className="conversion-meta"><th>Nama {snapshot?.activeProfile === "SOLAR_BAWAH" ? "Solar" : "INU"} <span>:</span></th><td colSpan={2}>{selected ? offers.find(o => o.offer.id === selected.offerId)?.vendor.name : "—"}</td></tr>
            <tr className="sheet-spacer"><td colSpan={3} /></tr>
            <tr><th>Uraian</th><th>{snapshot?.activeProfile === "SOLAR_BAWAH" ? "Harga Solar" : "Harga INU"}</th><th>Biaya</th></tr>
            {conversionRows.map((label, index) => <tr key={index} className={label === "ALL IN" ? "conversion-total" : ""}><th>{label}</th>
              {conversionColumns.map(column => <td key={column}>{slot("KONVERSI_JAGAD", `${column} · ${label}${label === "PPN" && index === 5 ? " OAT" : ""}`)}</td>)}
            </tr>)}
            <tr className="sheet-spacer"><td colSpan={3} /></tr>
            {["Gross Profit", "BPH Migas", "Net Margin", "PPH", "Profit MUE"].map(label => <tr key={label} className={label === "Profit MUE" ? "mue-row" : ""}><td>{label}</td>
              <td>{snapshot?.activeProfile === "SOLAR_BAWAH" && label === "Profit MUE" ? "—" : slot("KONVERSI_JAGAD", label)}</td><td>{label === "Profit MUE" ? "Crosscheck" : ""}</td>
            </tr>)}
          </tbody>
        </table>
      </div>

      <table className="ahs-sheet" aria-label="Analisis Harga Satuan AHS">
        <colgroup>{Array.from({ length: 6 }, (_, i) => <col key={i} />)}</colgroup>
        <thead><tr className="ahs-title"><th colSpan={6}>ANALISIS HARGA SATUAN (AHS)</th></tr></thead>
        <tbody>
          {[["Tgl Analisis (Rn)", "Sumber"], ["Marketing", "Lokasi"], ["Pembayaran", "Dokumen"], ["Harga Keekonomian", "Diskon"]].map(pair => <tr className="ahs-meta" key={pair[0]}>
            {pair.map(label => <Fragment key={label}><th>{label}</th><td colSpan={2}>{slot("AHS", label, "TEXT")}</td></Fragment>)}
          </tr>)}
          <tr className="ahs-meta ahs-include"><th colSpan={3}>HARGA INCLUDE</th><td colSpan={3}>{slot("AHS", "Harga Include")}</td></tr>
          {header("TOTAL PENDAPATAN", "income-row")}{header("HARGA JUAL SETELAH PAJAK", "income-row")}
          {["Harga Dasar", "PBBKB", "PPN 11%"].map((label, index) => <tr className="income-row" key={label}>
            {index === 0 && <th rowSpan={3} className="category">HARGA JUAL</th>}<td>{label}</td>
            <td>{slot("AHS", `Harga Jual · ${label}`)}</td><td>{slot("AHS", `Harga Jual · ${label} · Volume`)}</td><td>{slot("AHS", `Harga Jual · ${label} · Total`)}</td><td />
          </tr>)}
          {header("TOTAL BIAYA", "cost-row")}{header("BIAYA PER LITER", "cost-row")}
          {costGroups.flatMap(group => group.rows.map((label, index) => <tr className="cost-row" key={group.label + label}>
            {index === 0 && <th rowSpan={group.rows.length} className="category">{group.label}</th>}<td>{label}</td>
            <td className="currency-cell"><span>Rp</span>{slot("AHS", `${group.label} · ${label}`, "NUMERIC_TEXT", group.label === "HPP" && index === 0 ? hpp : undefined)}</td>
            <td>{slot("AHS", `${group.label} · ${label} · Volume`)}</td><td colSpan={2} className="currency-cell"><span>Rp</span>{slot("AHS", `${group.label} · ${label} · Total`)}</td>
          </tr>))}
          {summaryRows.map(label => header(label, "profit-row"))}
          <tr className="ahs-notes"><td colSpan={6}>Notes{slot("AHS", "Notes", "TEXT")}</td></tr>
        </tbody>
      </table>
      {fields.some(f => !used.has(f.cell.id)) && <table className="additional-sheet" aria-label="Baris tambahan workbook"><tbody>
        {fields.filter(f => !used.has(f.cell.id)).map(f => <tr key={f.cell.id}><th>{f.label}</th><td>{slot(f.stage, f.label, f.cell.source.kind === "INPUT" && f.cell.source.input.kind === "TEXT" ? "TEXT" : "NUMERIC_TEXT", f.cell)}</td><td>{value(f.cell)}</td></tr>)}
      </tbody></table>}
    </div>
  </div>;
}
