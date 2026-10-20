import type { WorkbookSnapshot, WorksheetSnapshot } from "./contracts.ts";
import type { StableId } from "./ids.ts";
import { ahsVolumeSource } from "./ahs-volume.ts";
import { updateCellInput } from "./commands.ts";
import { prepareLegacySheet } from "./legacy-sheet.ts";
import { numericInput } from "./numeric-input.ts";
import { PROFILES } from "./profiles.ts";
import { requireCondition } from "./validation.ts";
import { changeWorkbook, emptyWorkbook } from "./workflow.ts";

export interface AnalysisCreationInput {
  projectId?: StableId<"project">;
  projectName: string;
  analysisName: string;
  material: string;
  customer: string;
  location: string;
  analysisDate?: string;
  marketing?: string;
  payment?: string;
  economicPrice?: string;
  source?: string;
  document?: string;
  discount?: string;
  volume?: string;
}

export function analysisDateInput(now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function analysisPeriod(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-")) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return "";
  const months = ["JAN", "FEB", "MAR", "APR", "MEI", "JUN", "JUL", "AGU", "SEP", "OKT", "NOV", "DES"];
  return `P${Number(date.slice(8)) <= 14 ? 1 : 2}-${months[Number(date.slice(5, 7)) - 1]}-${date.slice(0, 4)}`;
}

function required(value: string, label: string): string {
  requireCondition(typeof value === "string" && value.trim().length > 0, `${label} wajib diisi.`);
  return value.trim();
}

export function createAnalysisWorkbook(input: AnalysisCreationInput): WorkbookSnapshot {
  const projectName = required(input.projectName, "Nama proyek");
  const analysisName = required(input.analysisName, "Nama analisis");
  const material = required(input.material, "Pekerjaan / Material");
  const customer = required(input.customer, "Customer");
  const location = required(input.location, "Lokasi");
  const date = input.analysisDate ?? analysisDateInput();
  const period = analysisPeriod(date);
  requireCondition(period !== "", "Tanggal analisis tidak valid.");

  const headers: Record<WorksheetSnapshot["stage"], Record<string, string>> = {
    EVALUASI_VENDOR: { "Pekerjaan / Material": material, Customer: customer, Lokasi: location },
    KONVERSI_JAGAD: { Periode: period, Lokasi: location },
    AHS: {
      "Tgl Analisis (Rn)": date.split("-").reverse().join("/"),
      Marketing: input.marketing?.trim() ?? "", Pembayaran: input.payment?.trim() ?? "",
      "Harga Keekonomian": input.economicPrice?.trim() ?? "", Sumber: input.source?.trim() ?? "",
      Lokasi: location, Dokumen: input.document?.trim() ?? "", Diskon: input.discount?.trim() ?? "",
    },
  };
  const snapshot = prepareLegacySheet(emptyWorkbook(projectName, analysisName, input.projectId));
  let workbook = changeWorkbook(snapshot, {
    worksheets: snapshot.worksheets.map(worksheet => ({ ...worksheet, tables: worksheet.tables.map(table => {
      const rows = new Map(table.rows.map(row => [row.id, row.label]));
      return { ...table, cells: table.cells.map(cell => {
        const label = rows.get(cell.rowId)!;
        if (!Object.hasOwn(headers[worksheet.stage], label)) return cell;
        const value = headers[worksheet.stage][label]!;
        return { ...cell, source: { kind: "INPUT" as const, input: value ? { kind: "TEXT" as const, text: value } : { kind: "UNSET" as const } } };
      }) };
    }) })),
  });
  const volume = numericInput(input.volume ?? "");
  if (!volume) return workbook;
  for (const profile of PROFILES) {
    const source = ahsVolumeSource(workbook, profile);
    requireCondition(source, `Sumber Volume AHS ${profile} tidak ditemukan.`);
    workbook = updateCellInput(workbook, profile, source.id, { kind: "NUMERIC_TEXT", text: volume });
  }
  return workbook;
}
