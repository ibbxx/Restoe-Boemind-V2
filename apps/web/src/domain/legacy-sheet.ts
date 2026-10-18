import type { CellInput, CellSnapshot, FormulaDefinition, TableSnapshot, WorkbookSnapshot, WorksheetSnapshot } from "./contracts.ts";
import { createStableId as id } from "./ids.ts";
import type { StableId } from "./ids.ts";
import { changeWorkbook } from "./workflow.ts";
import { SOURCE_SHEETS } from "./source-template.ts";
import { createProcurementWorkbook, formulaFromAddresses, sourceAddress, units } from "./procurement-template.ts";
import { parseFormula, references } from "../engine/parser.ts";
import { PROFILES } from "./profiles.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { DecimalArithmetic } from "../engine/decimal.ts";

let referenceTemplate: WorkbookSnapshot | undefined;

export function legacyConfiguration(s: WorkbookSnapshot, config: EngineConfiguration | null): EngineConfiguration {
  const cells = s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => ({ cell: c, label: t.rows.find(r => r.id === c.rowId)?.label ?? "" }))));
  const ids = new Set(cells.map(c => c.cell.id));
  const present = new Map(config?.units.map(u => [u.cellId, u]));
  return { version: config?.version ?? "legacy-sheet-v1", policyVersionId: config?.policyVersionId ?? (s.policy.status === "CONFIGURED" ? s.policy.versionId : id<"policy">()),
    decimal: config?.decimal ?? { scale: 5, rounding: "HALF_UP", roundAt: "EVERY_OPERATION" },
    units: cells.map(({ cell, label }) => {
      if (label.startsWith("@EV!") && (label.endsWith("|caption") || label.endsWith(":Nama vendor") || label.endsWith(":Notes"))) {
        return { cellId: cell.id, symbol: "1", dimensions: {} };
      }
      const templateUnit = label.split("|template:")[1] as keyof typeof units | undefined;
      if (templateUnit && Object.hasOwn(units, templateUnit)) return present.get(cell.id) ?? { cellId: cell.id,
        symbol: templateUnit === "text" ? "1" : templateUnit, dimensions: units[templateUnit] };
      const money = label.endsWith(" · Total") || ["TOTAL PENDAPATAN", "TOTAL BIAYA", "LABA KOTOR", "SELISIH PPN", "LABA BERSIH"].includes(label);
      const ratio = label === "PERSENTASE";
      return present.get(cell.id) ?? { cellId: cell.id, symbol: label.endsWith(" · Volume") ? "L" : money ? "IDR" : ratio ? "1" : "IDR/L",
        dimensions: label.endsWith(" · Volume") ? { volume: 1 } : money ? { money: 1 } : ratio ? {} : { money: 1, volume: -1 } };
    }),
    aggregates: config?.aggregates.filter(a => a.memberCellIds.every(id => ids.has(id))) ?? [], selectionDependentCellIds: config?.selectionDependentCellIds.filter(id => ids.has(id)) ?? [] };
}

export const vendorComponentLabels = ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "BPH", "TOTAL"];
export function vendorColumn(index: number) {
  let column = "", number = index + 3;
  while (number > 0) { number--; column = String.fromCharCode(65 + number % 26) + column; number = Math.floor(number / 26); }
  return column;
}
export function legacyVendorCell(s: WorkbookSnapshot, offerId: string, label: string) {
  return s.worksheets.find(w => w.stage === "EVALUASI_VENDOR")?.tables.flatMap(t => t.cells.filter(c =>
    t.rows.some(r => r.id === c.rowId && r.label.endsWith(`|vendor:${offerId}:${label}`)))).at(0);
}

// Materialize visible legacy slots once, retaining existing cells, formulas and immutable offer history.
export function prepareLegacySheet(s: WorkbookSnapshot): WorkbookSnapshot {
  if (s.workbook) return s;
  const unoffered = s.analysis.vendors.filter(v => !s.analysis.offers.some(o => o.vendorId === v.id));
  const vendors = [...s.analysis.vendors], offers = [...s.analysis.offers];
  for (const vendor of unoffered) offers.push({ id: id<"offer">(), analysisId: s.analysisId, vendorId: vendor.id, label: vendor.name });
  while (offers.length < 3) {
    const vendor = { id: id<"vendor">(), analysisId: s.analysisId, name: `Vendor ${offers.length + 1}` };
    vendors.push(vendor);
    offers.push({ id: id<"offer">(), analysisId: s.analysisId, vendorId: vendor.id, label: vendor.name });
  }
  if (offers.length !== s.analysis.offers.length) s = changeWorkbook(s, { analysis: { ...s.analysis, vendors, offers } });
  const additions = new Map<string, TableSnapshot[]>();
  const formulas: FormulaDefinition[] = [...s.formulas];
  const pending: { cell: CellSnapshot; expression: string; resolve: (address: string) => string }[] = [];
  const add = (stage: WorksheetSnapshot["stage"], scope: CellSnapshot["scope"], label: string, input: CellInput) => {
    const tableId = id<"table">(), rowId = id<"row">(), columnId = id<"column">();
    const cell: CellSnapshot = { id: id<"cell">(), tableId, rowId, columnId, scope, source: { kind: "INPUT", input } };
    const table: TableSnapshot = { id: tableId, rows: [{ id: rowId, label }], columns: [{ id: columnId, label: "Nilai" }],
      rowOrder: [rowId], columnOrder: [columnId], cells: [cell], merges: [] };
    additions.set(stage, [...(additions.get(stage) ?? []), table]);
    return cell;
  };
  const latestRevision = (offerId: string) => s.analysis.offerRevisions.filter(r => r.offerId === offerId).reduce<(typeof s.analysis.offerRevisions)[number] | undefined>(
    (latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
  const extraLabels = [...new Set(s.analysis.offers.flatMap(offer => latestRevision(offer.id)?.values.map(v => v.label) ?? []))]
    .filter(label => !label.startsWith("formula:") && ![...vendorComponentLabels, "Nama vendor", "Notes"].some(known => known.toLocaleLowerCase("id-ID") === label.toLocaleLowerCase("id-ID")));
  const captions: readonly (readonly [string, string])[] = [["B3", "EVALUASI HARGA VENDOR"], ["B4", ""], ["B5", "Pekerjaan / Material :"], ["B6", "Customer :"], ["B7", "Lokasi :"], ["B8", ""], ["B9", "Uraian"], ["B18", "Note :"],
    ...vendorComponentLabels.map((label, index) => [`B${index + 10}`, label] as const), ...extraLabels.map((label, index) => [`B${index + 19}`, label] as const)];
  for (const [address, text] of captions) {
    if (!s.worksheets.some(w => w.stage === "EVALUASI_VENDOR" && w.tables.some(t => t.rows.some(r => r.label.startsWith(`@EV!${address}|`))))) {
      add("EVALUASI_VENDOR", "SHARED", `@EV!${address}|caption`, text ? { kind: "TEXT", text } : { kind: "UNSET" });
    }
  }
  s.analysis.offers.forEach((offer, index) => {
    const revision = s.analysis.offerRevisions.filter(r => r.offerId === offer.id).reduce<(typeof s.analysis.offerRevisions)[number] | undefined>(
      (latest, r) => !latest || r.revisionNumber > latest.revisionNumber ? r : latest, undefined);
    const cells = new Map<string, CellSnapshot>();
    const pattern = (["C", "D", "E"] as const)[Math.min(index, 2)]!;
    for (const [label, row] of [["Nama vendor", 9], ["Notes", 18]] as const) {
      if (!legacyVendorCell(s, offer.id, label)) add("EVALUASI_VENDOR", "SHARED", `@EV!${vendorColumn(index)}${row}|vendor:${offer.id}:${label}`,
        label === "Nama vendor" ? { kind: "TEXT", text: s.analysis.vendors.find(v => v.id === offer.vendorId)!.name } : { kind: "UNSET" });
    }
    [...vendorComponentLabels, ...extraLabels].forEach((label, position) => {
      const row = position < vendorComponentLabels.length ? position + 10 : position - vendorComponentLabels.length + 19;
      const existing = legacyVendorCell(s, offer.id, label);
      if (existing) { cells.set(String(row), existing); return; }
      const value = revision?.values.find(v => v.label.toLocaleLowerCase("id-ID") === label.toLocaleLowerCase("id-ID"))?.input;
      const cell = add("EVALUASI_VENDOR", "SHARED", `@EV!${vendorColumn(index)}${row}|vendor:${offer.id}:${label}`, value ?? { kind: "UNSET" });
      cells.set(String(row), cell);
      const source = row <= 17 ? SOURCE_SHEETS[0]!.cells[pattern + row] : undefined;
      const custom = revision?.values.find(v => v.label === `formula:${label}`)?.input;
      if (custom?.kind === "TEXT") {
        pending.push({ cell, expression: custom.text.replace(/EV!([A-Z]+\d+)/gi, "$1"), resolve: address => {
          const found = cells.get(address.replace(/^[A-Z]+/, ""));
          if (!found || !address.startsWith(vendorColumn(index))) throw new Error("Referensi rumus vendor lama tidak ditemukan.");
          return found.id;
        } });
      } else if (label !== "PPH" && label !== "Harga Dasar" && source?.formula && (!value || value.kind === "UNSET")) {
        pending.push({ cell, expression: source.formula, resolve: address => {
          const found = cells.get(address.replace(/^[A-Z]+/, ""));
          if (!found) throw new Error("Referensi template vendor tidak ditemukan.");
          return found.id;
        } });
      }
    });
  });
  const worksheetFields: Record<string, string[]> = {
    EVALUASI_VENDOR: ["Pekerjaan / Material", "Customer", "Lokasi"],
    KONVERSI_JAGAD: ["Periode", "Lokasi", ...["Harga INU", "Biaya"].flatMap(column => ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "ALL IN"].map(row => `${column} · ${row}`)), "Gross Profit", "BPH Migas", "Net Margin", "PPH", "Profit MUE"],
    AHS: ["Tgl Analisis (Rn)", "Sumber", "Marketing", "Lokasi", "Pembayaran", "Dokumen", "Harga Keekonomian", "Diskon", "Harga Include", "TOTAL PENDAPATAN", "HARGA JUAL SETELAH PAJAK", "TOTAL BIAYA", "BIAYA PER LITER", "LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE", "Notes",
      ...["Harga Dasar", "PBBKB", "PPN 11%"].flatMap(label => ["", " · Volume", " · Total"].map(suffix => `Harga Jual · ${label}${suffix}`)),
      ...[["HPP", "Harga Dasar", "OAT", "PBBKB", "PPH INU 0,3%", "BPH Migas 0,25%"], ["PAJAK", "PPN 11%", "PPH penjualan"], ["COST OF FUND", "Investor", "Bunga Bank", "Diskonto SKBDN"], ["OPERASIONAL", "Biaya Operasional", "Bonus Marketing"], ["ASET", "Tangki Solar"], ["KOORDINASI", "Ormas/Lainnya"], ["RELASI", "Biaya Proyek", "Biaya Mediator"], ["RESIKO", "Biaya Resiko", "Kenaikan Harga"]].flatMap(([group, ...rows]) => rows.flatMap(label => ["", " · Volume", " · Total"].map(suffix => `${group} · ${label}${suffix}`)))],
  };
  const addresses = new Map<string, string>([
    ["Gross Profit", "C38"], ["BPH Migas", "C39"], ["Net Margin", "C40"], ["PPH", "C41"], ["Profit MUE", "C42"],
    ["Harga Include", "J8"], ["TOTAL PENDAPATAN", "L9"], ["HARGA JUAL SETELAH PAJAK", "L10"], ["TOTAL BIAYA", "L14"], ["BIAYA PER LITER", "L15"],
    ["LABA KOTOR", "L34"], ["SELISIH PPN", "L35"], ["LABA BERSIH", "L36"], ["LABA BERSIH PER LITER", "L37"], ["PERSENTASE", "L38"],
  ]);
  ["Harga Dasar", "PPN", "PBBKB", "PPH", "OAT", "PPN OAT", "ALL IN"].forEach((label, i) => {
    addresses.set(`Harga INU · ${label}`, `C${30 + i}`); addresses.set(`Biaya · ${label}`, `D${30 + i}`);
  });
  ["Harga Dasar", "PBBKB", "PPN 11%"].forEach((label, i) => {
    addresses.set(`Harga Jual · ${label}`, `I${11 + i}`); addresses.set(`Harga Jual · ${label} · Volume`, `J${11 + i}`); addresses.set(`Harga Jual · ${label} · Total`, `K${11 + i}`);
  });
  worksheetFields.AHS!.filter(label => /^(HPP|PAJAK|COST OF FUND|OPERASIONAL|ASET|KOORDINASI|RELASI|RESIKO) · /.test(label) && !label.endsWith(" · Volume") && !label.endsWith(" · Total")).forEach((label, i) => {
    addresses.set(label, `I${16 + i}`); addresses.set(label + " · Volume", `J${16 + i}`); addresses.set(label + " · Total", `K${16 + i}`);
  });
  const profileCells = new Map<string, Map<string, CellSnapshot>>(PROFILES.map(profile => [profile, new Map([[sourceAddress("I16", profile),
    s.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === s.profiles[profile].hppBase.cellId)!]])]));
  const seeded: { cell: CellSnapshot; address: string; profile: typeof PROFILES[number] }[] = [];
  for (const w of s.worksheets) for (const scope of w.stage === "EVALUASI_VENDOR" ? ["SHARED" as const] : PROFILES) {
    for (const label of worksheetFields[w.stage]!) {
      if (w.stage === "AHS" && label === "HPP · Harga Dasar") continue;
      const existing = w.tables.flatMap(t => t.cells.filter(c => c.scope === scope && t.rows.some(r => r.id === c.rowId && r.label === label)));
      const cell = existing[0] ?? add(w.stage, scope, label, { kind: "UNSET" });
      const address = w.stage !== "EVALUASI_VENDOR" ? addresses.get(label) : undefined;
      if (address && scope !== "SHARED") {
        profileCells.get(scope)!.set(sourceAddress(address, scope), cell);
        if (cell.source.kind === "INPUT" && cell.source.input.kind === "UNSET") seeded.push({ cell, address, profile: scope });
      }
    }
  }
  const writers = new Map<string, CellSnapshot["source"]>();
  if (seeded.length) {
    const template = referenceTemplate ??= createProcurementWorkbook("Template", "Formula definitions");
    const sourceCells = new Map(template.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => [c.id, c] as const))));
    const metadata = new Map(template.workbook!.cells.map(p => [p.cellId, p]));
    const sourceFormulas = new Map(template.formulas.map(f => [f.targetCellId, f]));
    const mirrored = new Set<string>();
    const copy = (source: CellSnapshot, target: CellSnapshot, profile: typeof PROFILES[number]) => {
      if (mirrored.has(target.id)) return;
      mirrored.add(target.id);
      const definition = sourceFormulas.get(source.id);
      if (!definition) return;
      const expression = definition.expression.replace(/@\{([0-9a-f-]+)\}/gi, (_, sourceId: string) => {
        const dependency = sourceCells.get(sourceId as StableId<"cell">);
        if (!dependency) throw new Error("Dependency template tidak ditemukan.");
        const meta = metadata.get(dependency.id)!;
        let destination = profileCells.get(profile)!.get(meta.address);
        if (!destination) {
          const stage = template.worksheets.find(w => w.tables.some(t => t.id === dependency.tableId))!.stage;
          destination = add(stage, profile, `@${stage === "AHS" ? "AHS-" : ""}${profile === "INU" ? "INU" : "SOLAR"}!${meta.address}|template:${meta.unit}`,
            dependency.source.kind === "INPUT" ? dependency.source.input : { kind: "UNSET" });
          profileCells.get(profile)!.set(meta.address, destination);
          copy(dependency, destination, profile);
        }
        return `@{${destination.id}}`;
      });
      const formulaId = id<"formula">();
      formulas.push({ ...definition, id: formulaId, versionId: id<"formula-version">(), targetCellId: target.id, expression,
        referenceCellIds: [...new Set(references(parseFormula(expression), () => []))] as StableId<"cell">[] });
      writers.set(target.id, { kind: "FORMULA", formulaId });
    };
    for (const item of seeded) {
      const source = [...sourceCells.values()].find(c => c.scope === item.profile && metadata.get(c.id)?.address === sourceAddress(item.address, item.profile));
      if (source) copy(source, item.cell, item.profile);
    }
  }
  for (const item of pending) {
    const formulaId = id<"formula">();
    const expression = item.expression.includes("@{") ? item.expression : formulaFromAddresses(item.expression, item.resolve, () => false);
    formulas.push({ id: formulaId, versionId: id<"formula-version">(), targetCellId: item.cell.id, expression,
      referenceCellIds: [...new Set(references(parseFormula(expression), () => []))] as StableId<"cell">[], activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: null });
    writers.set(item.cell.id, { kind: "FORMULA", formulaId });
  }
  if (!additions.size && !writers.size) return s.policy.status === "CONFIGURED" ? s
    : changeWorkbook(s, { policy: { status: "CONFIGURED", versionId: id<"policy">() } });
  const worksheets = s.worksheets.map(w => ({ ...w, tables: [...w.tables, ...(additions.get(w.stage) ?? [])].map(t => ({ ...t,
    cells: t.cells.map(c => writers.has(c.id) ? { ...c, source: writers.get(c.id)! } : c) })) }));
  const all = worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
  return changeWorkbook(s, { worksheets, formulas,
    policy: s.policy.status === "CONFIGURED" ? s.policy : { status: "CONFIGURED", versionId: id<"policy">() },
    profiles: Object.fromEntries(PROFILES.map(profile => [profile, {
    ...s.profiles[profile], cellIds: all.filter(c => c.scope === profile).map(c => c.id),
    formulaIds: formulas.filter(f => all.some(c => c.id === f.targetCellId && c.scope === profile)).map(f => f.id),
  }])) as unknown as WorkbookSnapshot["profiles"] });
}

export function connectAhsHpp(s: WorkbookSnapshot): WorkbookSnapshot {
  const pending = PROFILES.filter(profile => s.profiles[profile].hppBase.origin !== "CONVERSION_COST");
  if (!pending.length) return s;
  const sources = new Map(pending.map(profile => {
    const sourceId = s.workbook?.bindings.find(b => b.profile === profile && b.key === "cost")?.cellId ??
      s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.flatMap(t => t.cells.filter(c => c.scope === profile &&
        t.rows.some(r => r.id === c.rowId && r.label === "Biaya · Harga Dasar"))).at(0)?.id;
    if (!sourceId) throw new Error(`Biaya Konversi profil ${profile} belum tersedia untuk HPP.`);
    return [s.profiles[profile].hppBase.cellId, sourceId] as const;
  }));
  const added = [...sources].map(([targetCellId, sourceId]) => ({
    id: id<"formula">(), versionId: id<"formula-version">(), targetCellId, expression: `@{${sourceId}}`,
    referenceCellIds: [sourceId], activation: "ACTIVE" as const, sourceKind: "OPERATIONAL_OVERRIDE" as const, provenance: null,
  }));
  const formulaIds = new Map(added.map(f => [f.targetCellId, f.id]));
  return changeWorkbook(s, {
    formulas: [...s.formulas, ...added],
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
      rows: t.rows.map(r => t.cells.some(c => c.rowId === r.id && formulaIds.has(c.id)) && r.label.startsWith("HPP manual ")
        ? { ...r, label: "HPP · Harga Dasar" } : r),
      cells: t.cells.map(c => formulaIds.has(c.id) ? { ...c, source: { kind: "FORMULA" as const, formulaId: formulaIds.get(c.id)! } } : c),
    })) })),
    profiles: Object.fromEntries(PROFILES.map(profile => [profile, pending.includes(profile) ? {
      ...s.profiles[profile], hppBase: { ...s.profiles[profile].hppBase, origin: "CONVERSION_COST" as const, contextRunId: null },
      formulaIds: [...s.profiles[profile].formulaIds, formulaIds.get(s.profiles[profile].hppBase.cellId)!],
    } : s.profiles[profile]])) as unknown as WorkbookSnapshot["profiles"],
    ...(s.workbook ? { workbook: { ...s.workbook, cells: s.workbook.cells.map(p => formulaIds.has(p.cellId) ? { ...p, kind: "RESULT" as const } : p) } } : {}),
  });
}

export function makeAhsSaleInput(s: WorkbookSnapshot): WorkbookSnapshot {
  const ahs = s.worksheets.find(w => w.stage === "AHS");
  const find = (profile: typeof PROFILES[number], address: string, label: string) => ahs?.tables.flatMap(t => t.cells.filter(c =>
    c.scope === profile && (s.workbook
      ? s.workbook.cells.some(p => p.cellId === c.id && p.address === sourceAddress(address, profile))
      : t.rows.some(r => r.id === c.rowId && r.label === label)))).at(0);
  const decimal = new DecimalArithmetic(s.workbook?.configuration?.decimal ?? { scale: 5, rounding: "HALF_UP", roundAt: "EVERY_OPERATION" });
  const pending: { profile: typeof PROFILES[number]; gross: CellSnapshot; sale: CellSnapshot; input: CellInput;
    formula: FormulaDefinition | null; oldFormulaId: string | null }[] = [];
  for (const profile of PROFILES) {
    const gross = find(profile, "J8", "Harga Include"), sale = find(profile, "I11", "Harga Jual · Harga Dasar");
    const pbbkb = find(profile, "I12", "Harga Jual · PBBKB"), ppn = find(profile, "I13", "Harga Jual · PPN 11%");
    if (!gross || !sale || !pbbkb || !ppn || (gross.source.kind !== "INPUT" && gross.source.kind !== "FORMULA")) continue;
    const saleFormulaId = sale.source.kind === "FORMULA" ? sale.source.formulaId : null;
    const oldFormula = saleFormulaId ? s.formulas.find(f => f.id === saleFormulaId) : undefined;
    if (oldFormula && oldFormula.expression !== `@{${gross.id}}/1.11`) continue;
    const grossExpression = `SUM(@{${sale.id}},@{${pbbkb.id}},@{${ppn.id}})`;
    const grossFormulaId = gross.source.kind === "FORMULA" ? gross.source.formulaId : null;
    if (grossFormulaId && s.formulas.find(f => f.id === grossFormulaId)?.expression !== grossExpression) continue;
    if (gross.source.kind === "FORMULA" && sale.source.kind === "INPUT") continue;
    let input: CellInput = sale.source.kind === "INPUT" ? sale.source.input : { kind: "UNSET" };
    if ((sale.source.kind === "FORMULA" || (sale.source.kind === "INPUT" && sale.source.input.kind === "UNSET"))
      && gross.source.kind === "INPUT" && gross.source.input.kind === "NUMERIC_TEXT") {
      try { input = { kind: "NUMERIC_TEXT", text: decimal.format(decimal.apply("/", decimal.parse(gross.source.input.text), decimal.parse("1.11"))) }; }
      catch { continue; }
    }
    if (gross.source.kind === "INPUT" && gross.source.input.kind === "TEXT") continue;
    const formulaId = gross.source.kind === "INPUT" ? id<"formula">() : null;
    pending.push({ profile, gross, sale, input, oldFormulaId: oldFormula?.id ?? null,
      formula: formulaId ? { id: formulaId, versionId: id<"formula-version">(), targetCellId: gross.id,
        expression: grossExpression, referenceCellIds: [sale.id, pbbkb.id, ppn.id],
        activation: "ACTIVE", sourceKind: "OPERATIONAL_OVERRIDE", provenance: null } : null });
  }
  if (!pending.length) return s;
  const byGross = new Map(pending.filter(item => item.formula).map(item => [item.gross.id, item]));
  const bySale = new Map(pending.map(item => [item.sale.id, item]));
  const removed = new Set(pending.map(item => item.oldFormulaId).filter((value): value is string => value !== null));
  return changeWorkbook(s, {
    formulas: [...s.formulas.filter(f => !removed.has(f.id)), ...pending.flatMap(item => item.formula ? [item.formula] : [])],
    worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
      cells: t.cells.map(c => byGross.has(c.id) ? { ...c, source: { kind: "FORMULA" as const, formulaId: byGross.get(c.id)!.formula!.id } }
        : bySale.has(c.id) ? { ...c, source: { kind: "INPUT" as const, input: bySale.get(c.id)!.input } } : c),
    })) })),
    profiles: Object.fromEntries(PROFILES.map(profile => [profile, {
      ...s.profiles[profile], formulaIds: [...s.profiles[profile].formulaIds.filter(id => !removed.has(id)),
        ...pending.filter(item => item.profile === profile && item.formula).map(item => item.formula!.id)],
    }])) as unknown as WorkbookSnapshot["profiles"],
    ...(s.workbook ? { workbook: { ...s.workbook,
      cells: s.workbook.cells.map(p => byGross.has(p.cellId) ? { ...p, kind: "RESULT" as const }
        : bySale.has(p.cellId) ? { ...p, kind: "INPUT" as const } : p),
      bindings: s.workbook.bindings.map(b => b.key === "sale" && pending.some(item => item.profile === b.profile)
        ? { ...b, cellId: pending.find(item => item.profile === b.profile)!.sale.id } : b),
    } } : {}),
  });
}
