import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { decodeWorkbook, encodeWorkbook } from "../src/persistence/workbook-data.ts";
import { captureSavedWorkbook } from "../src/persistence/current-workbook.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../src/domain/legacy-sheet.ts";
import { prepareVendorColumns, selectSheetOffer, changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { prepareNumericBlanks } from "../src/domain/procurement-template.ts";
import { connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { prepareAhsRollups } from "../src/domain/ahs-groups.ts";
import { refreshCurrentOffers } from "../src/domain/current-offers.ts";
import { prepareCalculationPolicy } from "../src/domain/calculation-policy.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import { updateCellInput } from "../src/domain/commands.ts";
import type { StableId } from "../src/domain/ids.ts";
import { changeWorkbook } from "../src/domain/workflow.ts";

// Usage: node --experimental-transform-types scripts/complete-dummy-project.ts [--apply|--verify]
// Default is read-only: prepare and calculate locally. --apply updates only these three fixtures.
type DummyRow = { data: unknown; analysis_id: string; version: StableId<"version">; saved_by: StableId<"user">;
  saved_at: string; analysis_name: string; project_name: string };

const projectId = "11111111-1111-4111-8111-111111111111";
const result: { rows: DummyRow[] } = JSON.parse(execFileSync("supabase", ["db", "query", "--linked", "--output-format", "json",
  `select c.*, a.name as analysis_name, p.name as project_name from procurement.current_workbooks c
   join procurement.analyses a on a.id=c.analysis_id join procurement.projects p on p.id=c.project_id
   where c.project_id='${projectId}' order by c.analysis_id;`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
assert.equal(result.rows.length, 3);
assert.deepEqual(result.rows.map(r => r.analysis_id).sort(), ["34bc1538-40e3-465c-af04-028ab2db4a9f", "796580b4-86b9-4b81-a63d-c3bf27dfd088", "f232393a-7ba1-4ad6-8f84-5f4767b1fcd4"]);
const verify = process.argv.includes("--verify");
const namesOnly = process.argv.includes("--names");
const vendorNames = ["PT Sumber Energi Nusantara (Dummy)", "PT Mitra Bahan Bakar Indonesia (Dummy)", "PT Distribusi Solar Mandiri (Dummy)"];
const updates: string[] = [];
for (const row of result.rows) {
  const current = decodeWorkbook(row.data, { analysisId: row.analysis_id, projectId, analysisName: row.analysis_name, projectName: row.project_name });
  let { snapshot, configuration } = prepareCalculationPolicy(current.snapshot, current.configuration);
  if (!verify && namesOnly) {
    for (const [index, offer] of snapshot.analysis.offers.entries()) {
      const nameCell = snapshot.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.flatMap(t => t.cells.filter(c =>
        snapshot.workbook ? snapshot.workbook.offers.some(o => o.offerId === offer.id && o.nameCellId === c.id)
          : t.rows.some(r => r.id === c.rowId && r.label.endsWith(`|vendor:${offer.id}:Nama vendor`)))).at(0);
      assert(nameCell && vendorNames[index], "Dummy vendor name cell missing");
      snapshot = updateCellInput(snapshot, nameCell.scope, nameCell.id, { kind: "TEXT", text: vendorNames[index]! });
    }
    snapshot = refreshCurrentOffers(snapshot);
    snapshot = changeWorkbook(snapshot, { analysis: { ...snapshot.analysis,
      offers: snapshot.analysis.offers.map(o => ({ ...o, label: snapshot.analysis.vendors.find(v => v.id === o.vendorId)!.name })) } });
  }
  if (namesOnly) assert.deepEqual(snapshot.analysis.vendors.map(v => v.name), vendorNames);
  if (!verify && !namesOnly) {
  snapshot = prepareAhsRollups(connectAhsVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(snapshot)))))));
  const manual: Record<string, string> = {
    "Harga Keekonomian": "30000", "Harga Jual · Harga Dasar": "28000",
    "Biaya · PBBKB": "0", "Biaya · PPH": "0", "Biaya · OAT": "300", "Biaya · PPN OAT": "33",
    "Gross Profit": "200", "BPH Migas": "0", "Net Margin": "150", "PPH": "0", "Profit MUE": "150",
    "HPP · PPH INU 0,3%": "0", "HPP · BPH Migas 0,25%": "0", "PAJAK · PPH penjualan": "0",
    "COST OF FUND · Investor": "20", "COST OF FUND · Bunga Bank": "15", "COST OF FUND · Diskonto SKBDN": "10",
    "OPERASIONAL · Biaya Operasional": "100", "OPERASIONAL · Bonus Marketing": "50", "ASET · Tangki Solar": "25",
    "KOORDINASI · Ormas/Lainnya": "10", "RELASI · Biaya Proyek": "20", "RELASI · Biaya Mediator": "15",
    "RESIKO · Biaya Resiko": "30", "RESIKO · Kenaikan Harga": "50",
  };
  for (const worksheet of snapshot.worksheets) for (const table of worksheet.tables) for (const cell of table.cells) {
    if (cell.source.kind !== "INPUT" || cell.source.input.kind !== "UNSET") continue;
    const label = table.rows.find(r => r.id === cell.rowId)!.label;
    const vendor = label.match(/\|vendor:([^:]+):(.+)$/);
    let value = manual[label];
    if (vendor) {
      const index = snapshot.analysis.offers.findIndex(o => o.id === vendor[1]);
      value = ({ "Harga Dasar": String(20000 + index * 250), "PBBKB": "0", "PPH": "0", "OAT": String(300 + index * 25), "PPN OAT": "0", "BPH": "0" } as Record<string, string>)[vendor[2]!];
    }
    if (value !== undefined) snapshot = updateCellInput(snapshot, cell.scope, cell.id, { kind: "NUMERIC_TEXT", text: value });
    else if (label === "Notes" || vendor?.[2] === "Notes") snapshot = updateCellInput(snapshot, cell.scope, cell.id,
      { kind: "TEXT", text: "Simulasi dummy lengkap; nilai contoh untuk demonstrasi perhitungan." });
  }
  snapshot = refreshCurrentOffers(snapshot);
  // Explicit fixture selections only; the application continues to require manual vendor selection.
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) snapshot = selectSheetOffer(snapshot, snapshot.analysis.offers[0]!.id, row.saved_by, profile);
  configuration = snapshot.workbook?.configuration ?? legacyConfiguration(snapshot, configuration);
  }
  assert(configuration);
  captureSavedWorkbook({ snapshot, configuration, version: row.version, savedAt: new Date(row.saved_at).toISOString(), savedBy: row.saved_by });
  for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
    const run = new FormulaEngine(configuration).evaluate(changeSheetProfile(snapshot, profile));
    const cells = snapshot.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => ({ id: c.id, label: t.rows.find(r => r.id === c.rowId)?.label, stage: w.stage }))));
    const errors = run.provisional!.results.filter(r => !["VALUE", "ZERO", "TEXT"].includes(r.status));
    assert.equal(run.status, "NONFINAL", `${row.analysis_name}/${profile}: calculation failed`);
    assert.equal(errors.length, 0, `${row.analysis_name}/${profile}: incomplete cells`);
    if (profile === "INU") assert.equal(run.solver?.status, "SOLVED");
    const totals = snapshot.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables.flatMap(t => t.cells.filter(c => c.scope === profile &&
      t.rows.some(r => r.id === c.rowId && ["TOTAL PENDAPATAN", "TOTAL BIAYA", "LABA BERSIH", "LABA BERSIH PER LITER"].includes(r.label)))
      .map(c => ({label:t.rows.find(r => r.id === c.rowId)!.label,result:run.results.find(r => r.cellId === c.id)}))));
    console.error(JSON.stringify({ analysis: row.analysis_name, profile, status: run.status, provisional: run.provisional!.status, solver: run.solver,
      totals:totals.map(t => ({label:t.label,value:t.result && "value" in t.result ? t.result.value : null})),
      errors: errors.filter(r => !("code" in r) || !r.code.includes("DEPENDENCY")).map(r => ({ code: "code" in r ? r.code : r.status, ...cells.find(c => c.id === r.cellId) })) }));
  }
  const data = JSON.stringify(encodeWorkbook(snapshot, configuration));
  updates.push(`do $guard$ begin update procurement.current_workbooks set data=$full_dummy$${data}$full_dummy$::jsonb,
    version=gen_random_uuid(), saved_at=now(), mutation_id=gen_random_uuid(), request_signature=repeat('0',64)
    where analysis_id='${row.analysis_id}' and project_id='${projectId}' and version='${row.version}';
    if not found then raise exception 'Dummy workbook changed; completion cancelled'; end if; end $guard$;`);
}
const sql = "begin;\n" + updates.join("\n") + "\ncommit;\n";
if (process.argv.includes("--sql")) process.stdout.write(sql);
if (process.argv.includes("--apply")) {
  assert(!verify, "Use --apply and --verify separately");
  process.stdout.write(execFileSync("supabase", ["db", "query", "--linked", "--file", "/dev/stdin"],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 }));
}
