import type { CellInput, MappingDefinition, ProfileSnapshot, WorkbookSnapshot } from "./contracts.ts";
import { parseStableId } from "./ids.ts";
import type { EntityKind } from "./ids.ts";
import { parseProfile, PROFILES } from "./profiles.ts";
import { parseDynamicWorkbook, validateDynamicReferences } from "./dynamic-validation.ts";

export class DomainValidationError extends TypeError {
  readonly code = "INVALID_DOMAIN_STATE";
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainValidationError(message);
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object.");
  const result = value as Record<string, unknown>;
  requireCondition(Reflect.ownKeys(result).every(key => typeof key === "string" && keys.includes(key)) &&
    keys.every(key => Object.hasOwn(result, key)), "Unexpected or missing object field.");
  return result;
}

export function array(value: unknown): unknown[] {
  requireCondition(Array.isArray(value), "Expected an array.");
  requireCondition(Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from(value.keys()).every(index => Object.hasOwn(value, index)), "Arrays must be dense, without extra fields.");
  return value;
}

export function text(value: unknown, nonempty = false): string {
  requireCondition(typeof value === "string" && (!nonempty || value.trim().length > 0), "Expected text.");
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  requireCondition(typeof value === "string" && choices.includes(value as T), "Unknown discriminant.");
  return value as T;
}

export function nullableId<K extends EntityKind>(value: unknown) {
  return value === null ? null : parseStableId<K>(value);
}

export function parseCellInput(value: unknown): CellInput {
  requireCondition(value !== null && typeof value === "object", "Expected a cell input.");
  const kind = choice((value as Record<string, unknown>).kind, ["UNSET", "TEXT", "NUMERIC_TEXT"]);
  const input = object(value, kind === "UNSET" ? ["kind"] : ["kind", "text"]);
  return kind === "UNSET" ? { kind } : { kind, text: text(input.text) };
}

function parseProfileState(value: unknown): ProfileSnapshot {
  const p = object(value, ["hppBase", "cellIds", "formulaIds"]);
  const h = object(p.hppBase, ["origin", "cellId"]);
  return { hppBase: { origin: choice(h.origin, ["MANUAL", "CONVERSION_COST"]), cellId: parseStableId<"cell">(h.cellId) },
    cellIds: array(p.cellIds).map(id => parseStableId<"cell">(id)),
    formulaIds: array(p.formulaIds).map(id => parseStableId<"formula">(id)) };
}

export function parseMappingDefinition(value: unknown): MappingDefinition {
  const m = object(value, ["id", "analysisId", "scope", "sourceCellId", "targetCellId", "sourceComponent",
    "transformExpression", "sourceUnit", "targetUnit", "status", "provenance"]);
  const p = object(m.provenance, ["actorId", "sourceRef", "reason"]);
  return { id: parseStableId<"mapping">(m.id), analysisId: parseStableId<"analysis">(m.analysisId), scope: choice(m.scope, ["INU", "SOLAR_BAWAH", "SHARED"]),
    sourceCellId: parseStableId<"cell">(m.sourceCellId), targetCellId: parseStableId<"cell">(m.targetCellId),
    sourceComponent: text(m.sourceComponent, true), transformExpression: m.transformExpression === null ? null : text(m.transformExpression, true),
    sourceUnit: text(m.sourceUnit, true), targetUnit: text(m.targetUnit, true),
    status: choice(m.status, ["DRAFT", "ACTIVE", "REJECTED", "NEEDS_REVIEW"]),
    provenance: { actorId: parseStableId<"user">(p.actorId), sourceRef: p.sourceRef === null ? null : text(p.sourceRef, true), reason: p.reason === null ? null : text(p.reason, true) } };
}

// Structural validation only: raw numeric text and expressions have no arithmetic policy here.
export function parseSnapshot(value: unknown): WorkbookSnapshot {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  const root = object(value, ["schemaVersion", "id", "projectId", "project", "analysisId", "analysis", "mappings", "selectedOfferId",
    "activeProfile", "profiles", "worksheets", "formulas", "policy", ...(version === 3 ? ["workbook"] : []),
    ...(value && Object.hasOwn(value, "ahsGroups") ? ["ahsGroups"] : []),
    ...(value && Object.hasOwn(value, "ahsFields") ? ["ahsFields"] : [])]);
  requireCondition(version === 2 || version === 3, "Unsupported snapshot schema version; legacy ownership must be migrated explicitly.");
  const state = object(root.analysis, ["analysis", "vendors", "offers"]);
  const analysis = object(state.analysis, ["id", "projectId", "name"]);
  const project = object(root.project, ["id", "name"]);
  const profiles = object(root.profiles, PROFILES);
  const policyObject = object(root.policy, (root.policy as { status?: unknown } | null)?.status === "CONFIGURED"
    ? ["status", "versionId"] : ["status"]);
  const policyStatus = choice(policyObject.status, ["CONFIGURED", "UNCONFIGURED"]);
  const snapshot: WorkbookSnapshot = {
    schemaVersion: version,
    ...(Object.hasOwn(root, "ahsGroups") ? { ahsGroups: array(root.ahsGroups).map(raw => {
      const g = object(raw, ["id", "profile", "name", "builtin", "labelCellId", "items", ...(raw && Object.hasOwn(raw, "section") ? ["section"] : [])]);
      requireCondition(typeof g.builtin === "boolean", "Invalid AHS group kind.");
      return { ...(Object.hasOwn(g, "section") ? { section: choice(g.section, ["PENDAPATAN", "BIAYA"]) } : {}),
        id: parseStableId<"ahs-group">(g.id), profile: parseProfile(g.profile), name: text(g.name, true), builtin: g.builtin,
        labelCellId: nullableId<"cell">(g.labelCellId), items: array(g.items).map(raw => {
          const item = object(raw, ["name", "builtin", "labelCellId", "priceCellId", "volumeCellId", "totalCellId"]);
          requireCondition(typeof item.builtin === "boolean", "Invalid AHS item kind.");
          return { name: text(item.name, true), builtin: item.builtin, labelCellId: nullableId<"cell">(item.labelCellId),
            priceCellId: parseStableId<"cell">(item.priceCellId), volumeCellId: parseStableId<"cell">(item.volumeCellId), totalCellId: parseStableId<"cell">(item.totalCellId) };
        }) };
    }) } : {}),
    ...(Object.hasOwn(root, "ahsFields") ? { ahsFields: array(root.ahsFields).map(raw => {
      const f = object(raw, ["section", "profile", "name", "labelCellId", "valueCellId", "valueType"]);
      const section = choice(f.section, ["INFORMASI", "LABA"]);
      const valueType = choice(f.valueType, ["TEXT", "NUMBER", "IDR", "IDR/L", "PERCENT"]);
      requireCondition(section === "INFORMASI" ? ["TEXT", "NUMBER"].includes(valueType) : valueType !== "TEXT", "Jenis nilai tidak sesuai bagian AHS.");
      return { section, valueType, profile: parseProfile(f.profile), name: text(f.name, true),
        labelCellId: parseStableId<"cell">(f.labelCellId), valueCellId: parseStableId<"cell">(f.valueCellId) };
    }) } : {}),
    ...(version === 3 ? { workbook: parseDynamicWorkbook(root.workbook) } : {}),
    id: parseStableId<"snapshot">(root.id),
    projectId: parseStableId<"project">(root.projectId),
    project: { id: parseStableId<"project">(project.id), name: text(project.name, true) },
    analysisId: parseStableId<"analysis">(root.analysisId),
    mappings: array(root.mappings).map(parseMappingDefinition),
    analysis: {
      analysis: { id: parseStableId<"analysis">(analysis.id), projectId: parseStableId<"project">(analysis.projectId), name: text(analysis.name, true) },
      vendors: array(state.vendors).map(value => {
        const v = object(value, ["id", "analysisId", "name"]);
        return { id: parseStableId<"vendor">(v.id), analysisId: parseStableId<"analysis">(v.analysisId), name: text(v.name, true) };
      }),
      offers: array(state.offers).map(value => {
        const o = object(value, ["id", "analysisId", "vendorId", "label", "values"]);
        return { id: parseStableId<"offer">(o.id), analysisId: parseStableId<"analysis">(o.analysisId),
          vendorId: parseStableId<"vendor">(o.vendorId), label: text(o.label), values: array(o.values).map(value => {
            const v = object(value, ["id", "label", "input"]);
            return { id: parseStableId<"offer-value">(v.id), label: text(v.label), input: parseCellInput(v.input) };
          }) };
      }),
    },
    selectedOfferId: nullableId<"offer">(root.selectedOfferId),
    activeProfile: parseProfile(root.activeProfile),
    profiles: { INU: parseProfileState(profiles.INU), SOLAR_BAWAH: parseProfileState(profiles.SOLAR_BAWAH) },
    worksheets: array(root.worksheets).map(value => {
      const w = object(value, ["id", "stage", "label", "tables"]);
      return { id: parseStableId<"worksheet">(w.id), stage: choice(w.stage, ["EVALUASI_VENDOR", "KONVERSI_JAGAD", "AHS"]),
        label: text(w.label), tables: array(w.tables).map(value => {
          requireCondition(value !== null && typeof value === "object", "Expected a table object.");
          const hasMerges = Object.hasOwn(value, "merges");
          const t = object(value, hasMerges ? ["id", "rows", "columns", "rowOrder", "columnOrder", "cells", "merges"] : ["id", "rows", "columns", "rowOrder", "columnOrder", "cells"]);
          const rawCells = array(t.cells) as Record<string, unknown>[];
          const rawMerges = array(hasMerges ? t.merges : []) as Record<string, unknown>[];
          const rowIds = array(t.rowOrder).map(id => parseStableId<"row">(id));
          const columnIds = array(t.columnOrder).map(id => parseStableId<"column">(id));
          const cellById = new Map(rawCells.map(c => [String(c.id), c]));
          const mergeBoxes = rawMerges.map(value => {
            const m = object(value, ["id", "anchorCellId", "rowSpan", "colSpan"]);
            const anchor = cellById.get(String(m.anchorCellId));
            requireCondition(anchor, "Merge anchor tidak ditemukan pada tabel.");
            const row = rowIds.indexOf(parseStableId<"row">(anchor.rowId));
            const column = columnIds.indexOf(parseStableId<"column">(anchor.columnId));
            requireCondition(row >= 0 && column >= 0 && Number.isInteger(m.rowSpan) && Number(m.rowSpan) >= 1 && Number.isInteger(m.colSpan) && Number(m.colSpan) >= 1 && row + Number(m.rowSpan) <= rowIds.length && column + Number(m.colSpan) <= columnIds.length, "Merge span keluar dari tabel.");
            return { row, column, rowSpan: Number(m.rowSpan), colSpan: Number(m.colSpan) };
          });
          for (let i = 0; i < mergeBoxes.length; i++) for (let j = i + 1; j < mergeBoxes.length; j++) {
            const a = mergeBoxes[i]!, b = mergeBoxes[j]!;
            requireCondition(a.row + a.rowSpan <= b.row || b.row + b.rowSpan <= a.row || a.column + a.colSpan <= b.column || b.column + b.colSpan <= a.column, "Merge tabel tidak boleh bertumpuk.");
          }
          return { id: parseStableId<"table">(t.id), rows: array(t.rows).map(value => {
            const r = object(value, ["id", "label"]);
            return { id: parseStableId<"row">(r.id), label: text(r.label) };
          }), columns: array(t.columns).map(value => {
            const c = object(value, ["id", "label"]);
            return { id: parseStableId<"column">(c.id), label: text(c.label) };
          }), rowOrder: array(t.rowOrder).map(id => parseStableId<"row">(id)),
          columnOrder: array(t.columnOrder).map(id => parseStableId<"column">(id)),
          cells: array(t.cells).map(value => {
            const c = object(value, ["id", "tableId", "rowId", "columnId", "scope", "source"]);
            const sourceKind = (c.source as { kind?: unknown } | null)?.kind;
            const s = object(c.source, sourceKind === "INPUT" ? ["kind", "input"] :
              sourceKind === "MAPPING" ? ["kind", "mappingId"] : ["kind", "formulaId"]);
            const kind = choice(s.kind, ["INPUT", "FORMULA", "MAPPING"]);
            return { id: parseStableId<"cell">(c.id), tableId: parseStableId<"table">(c.tableId),
              rowId: parseStableId<"row">(c.rowId), columnId: parseStableId<"column">(c.columnId),
              scope: choice(c.scope, ["INU", "SOLAR_BAWAH", "SHARED"]), source: kind === "INPUT"
                ? { kind, input: parseCellInput(s.input) } : kind === "FORMULA"
                  ? { kind, formulaId: parseStableId<"formula">(s.formulaId) }
                  : { kind, mappingId: parseStableId<"mapping">(s.mappingId) } };
          }), merges: rawMerges.map(value => {
            const m = object(value, ["id", "anchorCellId", "rowSpan", "colSpan"]);
            requireCondition(Number.isInteger(m.rowSpan) && Number(m.rowSpan) >= 1 && Number.isInteger(m.colSpan) && Number(m.colSpan) >= 1, "Invalid table merge span.");
            return { id: parseStableId<"merge">(m.id), anchorCellId: parseStableId<"cell">(m.anchorCellId), rowSpan: Number(m.rowSpan), colSpan: Number(m.colSpan) };
          }) };
        }) };
    }),
    formulas: array(root.formulas).map(value => {
      const f = object(value, ["id", "targetCellId", "expression", "referenceCellIds", "sourceKind", "activation", "provenance"]);
      const p = f.provenance === null ? null : object(f.provenance, ["workbookSha256", "sheet", "address"]);
      if (p) requireCondition(typeof p.workbookSha256 === "string" && /^[0-9a-f]{64}$/.test(p.workbookSha256), "Invalid provenance hash.");
      return { id: parseStableId<"formula">(f.id), targetCellId: parseStableId<"cell">(f.targetCellId), expression: text(f.expression, true),
        referenceCellIds: array(f.referenceCellIds).map(id => parseStableId<"cell">(id)),
        sourceKind: choice(f.sourceKind, ["WORKBOOK_SOURCE", "OPERATIONAL_OVERRIDE", "MAPPING"]),
        activation: choice(f.activation, ["DRAFT", "ACTIVE"]),
        provenance: p ? { workbookSha256: text(p.workbookSha256), sheet: text(p.sheet, true), address: text(p.address, true) } : null };
    }),
    policy: policyStatus === "UNCONFIGURED" ? { status: policyStatus }
      : { status: policyStatus, versionId: parseStableId<"policy">(policyObject.versionId) },
  };
  validateReferences(snapshot);
  validateDynamicReferences(snapshot);
  return snapshot;
}

function unique(ids: readonly string[], label: string) {
  requireCondition(new Set(ids).size === ids.length, "Duplicate ID: " + label);
}

function sameMembers(actual: readonly string[], expected: readonly string[], label: string) {
  unique(actual, label);
  requireCondition(actual.length === expected.length && expected.every(id => actual.includes(id)), "Invalid membership: " + label);
}

function validateReferences(s: WorkbookSnapshot) {
  const p = s.analysis;
  requireCondition(s.project.id === s.projectId && p.analysis.projectId === s.projectId && p.analysis.id === s.analysisId, "Analysis/project scope mismatch.");
  const tables = s.worksheets.flatMap(w => w.tables);
  const cells = tables.flatMap(t => t.cells);
  const allIds: readonly string[] = [s.id, s.project.id, s.analysisId, ...p.vendors.map(v => v.id), ...p.offers.map(o => o.id),
    ...p.offers.flatMap(r => r.values.map(v => v.id)),
    ...s.worksheets.map(w => w.id), ...tables.flatMap(t => [t.id, ...t.rows.map(r => r.id), ...t.columns.map(c => c.id), ...t.merges.map(m => m.id)]),
    ...cells.map(c => c.id), ...s.formulas.map(f => f.id),
    ...s.mappings.map(m => m.id)];
  unique(allIds, "entity inventory");
  const vendors = new Set(p.vendors.map(v => v.id));
  const offers = new Set(p.offers.map(o => o.id));
  p.vendors.forEach(v => requireCondition(v.analysisId === s.analysisId, "Vendor belongs to another analysis."));
  p.offers.forEach(o => requireCondition(o.analysisId === s.analysisId && vendors.has(o.vendorId), "Invalid offer vendor/analysis reference."));
  requireCondition(s.selectedOfferId === null || offers.has(s.selectedOfferId), "Selected activeOffer does not exist.");
  for (const t of tables) {
    sameMembers(t.rowOrder, t.rows.map(r => r.id), "row order");
    sameMembers(t.columnOrder, t.columns.map(c => c.id), "column order");
    unique(t.cells.map(c => c.rowId + ":" + c.columnId), "cell position");
    t.cells.forEach(c => requireCondition(c.tableId === t.id && t.rowOrder.includes(c.rowId) &&
      t.columnOrder.includes(c.columnId), "Cell refers to another table or missing row/column."));
  }
  const byCell = new Map(cells.map(c => [c.id, c]));
  const ahsCellIds = new Set(s.worksheets.filter(w => w.stage === "AHS").flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
  unique((s.ahsGroups ?? []).map(g => g.profile + ":" + g.id), "AHS groups");
  const ahsMembers: string[] = [];
  const ahsNames = new Set<string>();
  const ahsLabelIds: string[] = [];
  for (const group of s.ahsGroups ?? []) {
    requireCondition(group.items.length > 0, "Kelompok AHS wajib memiliki uraian.");
    const memberIds = [...(group.labelCellId ? [group.labelCellId] : []), ...group.items.flatMap(item =>
      [item.priceCellId, item.volumeCellId, item.totalCellId, ...(item.labelCellId ? [item.labelCellId] : [])])];
    requireCondition(memberIds.every(id => ahsCellIds.has(id) && byCell.get(id)?.scope === group.profile), "Referensi kelompok AHS hilang atau lintas profil.");
    const nameOf = (entry: { name: string; labelCellId: string | null; builtin: boolean }) => {
      const source = entry.labelCellId ? byCell.get(parseStableId<"cell">(entry.labelCellId))?.source : undefined;
      if (!entry.builtin) requireCondition(source?.kind === "INPUT" && source.input.kind === "TEXT" && source.input.text.trim(), "Nama tambahan AHS wajib berupa teks dan tidak boleh kosong.");
      return (source?.kind === "INPUT" && source.input.kind === "TEXT" ? source.input.text : entry.name).trim().toLocaleLowerCase("id-ID");
    };
    const groupName = group.profile + ":" + (group.section ?? "BIAYA") + ":" + nameOf(group);
    requireCondition(!ahsNames.has(groupName), "Nama kelompok sudah digunakan."); ahsNames.add(groupName);
    if (group.labelCellId) ahsLabelIds.push(group.labelCellId);
    const names = new Set<string>();
    for (const item of group.items) {
      unique([item.priceCellId, item.volumeCellId, item.totalCellId, ...(item.labelCellId ? [item.labelCellId] : [])], "AHS item cells");
      ahsMembers.push(item.priceCellId, item.volumeCellId, item.totalCellId);
      if (item.labelCellId) ahsLabelIds.push(item.labelCellId);
      const name = nameOf(item);
      requireCondition(!names.has(name), "Nama uraian sudah digunakan dalam kelompok ini."); names.add(name);
      if (!item.builtin) {
        const source = byCell.get(item.priceCellId)!.source;
        requireCondition(source.kind === "FORMULA" || (source.kind === "INPUT" && (source.input.kind === "UNSET" ||
          (source.input.kind === "NUMERIC_TEXT" && source.input.text.length <= 258 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source.input.text)))), "Biaya per liter wajib berupa angka atau rumus.");
      }
    }
  }
  unique(ahsMembers, "AHS group membership");
  const reservedNames = {
    INFORMASI: ["Tgl Analisis (Rn)", "Sumber", "Marketing", "Lokasi", "Pembayaran", "Dokumen", "Harga Keekonomian", "Diskon", "Harga Include"],
    LABA: ["LABA KOTOR", "SELISIH PPN", "LABA BERSIH", "LABA BERSIH PER LITER", "PERSENTASE"],
  };
  const fieldNames = new Set<string>();
  for (const field of s.ahsFields ?? []) {
    requireCondition([field.labelCellId, field.valueCellId].every(id => ahsCellIds.has(id) && byCell.get(id)?.scope === field.profile) &&
      field.labelCellId !== field.valueCellId && !ahsMembers.includes(field.valueCellId), "Referensi uraian AHS hilang atau lintas profil.");
    const label = byCell.get(field.labelCellId)!.source;
    requireCondition(label.kind === "INPUT" && label.input.kind === "TEXT" && label.input.text.trim(), "Nama uraian AHS wajib berupa teks.");
    const name = label.input.text.trim().toLocaleLowerCase("id-ID"), key = `${field.profile}:${field.section}:${name}`;
    requireCondition(!fieldNames.has(key) && !reservedNames[field.section].some(n => n.toLocaleLowerCase("id-ID") === name), "Nama uraian sudah digunakan.");
    fieldNames.add(key); ahsLabelIds.push(field.labelCellId);
    const value = byCell.get(field.valueCellId)!.source;
    requireCondition(value.kind !== "MAPPING" && (field.valueType === "TEXT" || value.kind === "FORMULA" || (value.kind === "INPUT" &&
      (value.input.kind === "UNSET" || (value.input.kind === "NUMERIC_TEXT" && value.input.text.length <= 258 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.input.text))))), "Nilai uraian AHS wajib berupa angka atau rumus.");
  }
  unique((s.ahsFields ?? []).map(f => f.valueCellId), "AHS fields");
  unique(ahsLabelIds, "AHS labels");
  unique([...ahsMembers, ...ahsLabelIds, ...(s.ahsFields ?? []).map(f => f.valueCellId)], "AHS cell roles");
  for (const m of s.mappings) {
    const source = byCell.get(m.sourceCellId);
    const target = byCell.get(m.targetCellId);
    requireCondition(m.analysisId === s.analysisId && source && target &&
      target.scope === m.scope && (source.scope === "SHARED" || source.scope === m.scope), "Invalid mapping reference or scope.");
    requireCondition(!Object.values(s.profiles).some(p => p.hppBase.cellId === m.targetCellId), "Mapping cannot replace the AHS HPP source.");
  }
  requireCondition(s.policy.status !== "CONFIGURED" || !allIds.includes(s.policy.versionId), "Policy ID is another entity kind.");
  const byFormula = new Map(s.formulas.map(f => [f.id, f]));
  cells.forEach(c => {
    if (c.source.kind === "MAPPING") {
      const mappingId = c.source.mappingId;
      requireCondition(s.mappings.some(m => m.id === mappingId && m.targetCellId === c.id), "Missing mapping writer.");
    }
  });
  for (const f of s.formulas) {
    const target = byCell.get(f.targetCellId);
    requireCondition(target?.source.kind === "FORMULA" && target.source.formulaId === f.id, "Formula target/writer mismatch.");
    unique(f.referenceCellIds, "declared references");
    f.referenceCellIds.forEach(id => {
      const ref = byCell.get(id);
      requireCondition(ref && (ref.scope === "SHARED" || ref.scope === target.scope), "Invalid or cross-profile formula reference.");
    });
  }
  cells.filter(c => c.source.kind === "FORMULA").forEach(c => {
    requireCondition(c.source.kind === "FORMULA" && byFormula.get(c.source.formulaId)?.targetCellId === c.id, "Missing formula writer.");
  });
  for (const profile of PROFILES) {
    const state = s.profiles[profile];
    sameMembers(state.cellIds, cells.filter(c => c.scope === profile).map(c => c.id), profile + " cells");
    sameMembers(state.formulaIds, s.formulas.filter(f => byCell.get(f.targetCellId)?.scope === profile).map(f => f.id), profile + " formulas");
    const hpp = byCell.get(state.hppBase.cellId);
    requireCondition(hpp?.scope === profile && hpp.source.kind === (state.hppBase.origin === "MANUAL" ? "INPUT" : "FORMULA"),
      "HPP writer does not match its source.");
    requireCondition(s.worksheets.some(w => w.stage === "AHS" && w.tables.some(t => t.cells.some(c => c.id === hpp.id))), "HPP must belong to AHS.");
    if (state.hppBase.origin === "CONVERSION_COST" && hpp.source.kind === "FORMULA") {
      const costId = s.workbook?.bindings.find(b => b.profile === profile && b.key === "cost")?.cellId ??
        s.worksheets.find(w => w.stage === "KONVERSI_JAGAD")?.tables.flatMap(t => t.cells.filter(c => c.scope === profile &&
          t.rows.some(r => r.id === c.rowId && r.label === "Biaya · Harga Dasar"))).at(0)?.id;
      const formula = byFormula.get(hpp.source.formulaId);
      requireCondition(costId && formula?.expression === `@{${costId}}` && formula.referenceCellIds.length === 1 &&
        formula.referenceCellIds[0] === costId, "HPP must follow the conversion cost for its own profile.");
    }
  }
}
