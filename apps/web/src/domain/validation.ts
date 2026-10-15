import type { CellInput, MappingVersion, ProfileSnapshot, ReviewContext, WorkbookSnapshot } from "./contracts.ts";
import { parseStableId } from "./ids.ts";
import type { EntityKind } from "./ids.ts";
import { parseProfile, PROFILES } from "./profiles.ts";

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
  const p = object(value, ["hppBase", "cellIds", "formulaIds", "reviewContext"]);
  const h = object(p.hppBase, ["origin", "cellId", "contextRunId"]);
  return { hppBase: { origin: choice(h.origin, ["MANUAL"]), cellId: parseStableId<"cell">(h.cellId),
    contextRunId: nullableId<"run">(h.contextRunId) },
    cellIds: array(p.cellIds).map(id => parseStableId<"cell">(id)),
    formulaIds: array(p.formulaIds).map(id => parseStableId<"formula">(id)),
    reviewContext: p.reviewContext === null ? null : parseReviewContext(p.reviewContext) };
}

export function parseReviewContext(value: unknown): ReviewContext {
  const r = object(value, ["snapshotId", "profile", "selectedOfferRevisionId", "mappingVersionIds", "inputCellIds",
    "runId", "freshness", "decisionStatus"]);
  return { snapshotId: parseStableId<"snapshot">(r.snapshotId), profile: parseProfile(r.profile),
    selectedOfferRevisionId: nullableId<"offer-revision">(r.selectedOfferRevisionId),
    mappingVersionIds: array(r.mappingVersionIds).map(id => parseStableId<"mapping-version">(id)),
    inputCellIds: array(r.inputCellIds).map(id => parseStableId<"cell">(id)), runId: nullableId<"run">(r.runId),
    freshness: choice(r.freshness, ["CURRENT", "STALE"]), decisionStatus: choice(r.decisionStatus, ["DRAFT", "CONFIRMED", "NEEDS_REVIEW"]) };
}

export function parseMappingVersion(value: unknown): MappingVersion {
  const m = object(value, ["id", "versionId", "analysisId", "scope", "sourceCellId", "targetCellId", "sourceComponent",
    "transformExpression", "sourceUnit", "targetUnit", "status", "provenance"]);
  const p = object(m.provenance, ["actorId", "changeEventId", "sourceRef", "reason"]);
  return { id: parseStableId<"mapping">(m.id), versionId: parseStableId<"mapping-version">(m.versionId),
    analysisId: parseStableId<"analysis">(m.analysisId), scope: choice(m.scope, ["INU", "SOLAR_BAWAH", "SHARED"]),
    sourceCellId: parseStableId<"cell">(m.sourceCellId), targetCellId: parseStableId<"cell">(m.targetCellId),
    sourceComponent: text(m.sourceComponent, true), transformExpression: m.transformExpression === null ? null : text(m.transformExpression, true),
    sourceUnit: text(m.sourceUnit, true), targetUnit: text(m.targetUnit, true),
    status: choice(m.status, ["DRAFT", "ACTIVE", "REJECTED", "NEEDS_REVIEW"]),
    provenance: { actorId: parseStableId<"user">(p.actorId), changeEventId: parseStableId<"change-event">(p.changeEventId),
      sourceRef: p.sourceRef === null ? null : text(p.sourceRef, true), reason: p.reason === null ? null : text(p.reason, true) } };
}

// Structural validation only: raw numeric text and expressions have no arithmetic policy here.
export function parseSnapshot(value: unknown): WorkbookSnapshot {
  const root = object(value, ["schemaVersion", "id", "projectId", "project", "analysisId", "analysis", "mappings", "selectedOfferRevisionId",
    "activeProfile", "profiles", "worksheets", "formulas", "policy", "calculationRunRefs"]);
  requireCondition(root.schemaVersion === 2, "Unsupported snapshot schema version; legacy ownership must be migrated explicitly.");
  const state = object(root.analysis, ["analysis", "vendors", "offers", "offerRevisions"]);
  const analysis = object(state.analysis, ["id", "projectId", "name"]);
  const project = object(root.project, ["id", "name"]);
  const profiles = object(root.profiles, PROFILES);
  const policyObject = object(root.policy, (root.policy as { status?: unknown } | null)?.status === "CONFIGURED"
    ? ["status", "versionId"] : ["status"]);
  const policyStatus = choice(policyObject.status, ["CONFIGURED", "UNCONFIGURED"]);
  const snapshot: WorkbookSnapshot = {
    schemaVersion: 2,
    id: parseStableId<"snapshot">(root.id),
    projectId: parseStableId<"project">(root.projectId),
    project: { id: parseStableId<"project">(project.id), name: text(project.name, true) },
    analysisId: parseStableId<"analysis">(root.analysisId),
    mappings: array(root.mappings).map(parseMappingVersion),
    analysis: {
      analysis: { id: parseStableId<"analysis">(analysis.id), projectId: parseStableId<"project">(analysis.projectId), name: text(analysis.name, true) },
      vendors: array(state.vendors).map(value => {
        const v = object(value, ["id", "analysisId", "name"]);
        return { id: parseStableId<"vendor">(v.id), analysisId: parseStableId<"analysis">(v.analysisId), name: text(v.name, true) };
      }),
      offers: array(state.offers).map(value => {
        const o = object(value, ["id", "analysisId", "vendorId", "label"]);
        return { id: parseStableId<"offer">(o.id), analysisId: parseStableId<"analysis">(o.analysisId),
          vendorId: parseStableId<"vendor">(o.vendorId), label: text(o.label) };
      }),
      offerRevisions: array(state.offerRevisions).map(value => {
        const r = object(value, ["id", "offerId", "revisionNumber", "values"]);
        requireCondition(Number.isSafeInteger(r.revisionNumber) && typeof r.revisionNumber === "number" &&
          r.revisionNumber > 0, "Offer revision number must be a positive safe integer.");
        return { id: parseStableId<"offer-revision">(r.id), offerId: parseStableId<"offer">(r.offerId),
          revisionNumber: r.revisionNumber, values: array(r.values).map(value => {
            const v = object(value, ["id", "label", "input"]);
            return { id: parseStableId<"offer-value">(v.id), label: text(v.label), input: parseCellInput(v.input) };
          }) };
      }),
    },
    selectedOfferRevisionId: nullableId<"offer-revision">(root.selectedOfferRevisionId),
    activeProfile: parseProfile(root.activeProfile),
    profiles: { INU: parseProfileState(profiles.INU), SOLAR_BAWAH: parseProfileState(profiles.SOLAR_BAWAH) },
    worksheets: array(root.worksheets).map(value => {
      const w = object(value, ["id", "stage", "label", "tables"]);
      return { id: parseStableId<"worksheet">(w.id), stage: choice(w.stage, ["EVALUASI_VENDOR", "KONVERSI_JAGAD", "AHS"]),
        label: text(w.label), tables: array(w.tables).map(value => {
          const t = object(value, ["id", "rows", "columns", "rowOrder", "columnOrder", "cells"]);
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
          }) };
        }) };
    }),
    formulas: array(root.formulas).map(value => {
      const f = object(value, ["id", "versionId", "targetCellId", "expression", "referenceCellIds", "sourceKind", "activation", "provenance"]);
      const p = f.provenance === null ? null : object(f.provenance, ["workbookSha256", "sheet", "address"]);
      if (p) requireCondition(typeof p.workbookSha256 === "string" && /^[0-9a-f]{64}$/.test(p.workbookSha256), "Invalid provenance hash.");
      return { id: parseStableId<"formula">(f.id), versionId: parseStableId<"formula-version">(f.versionId),
        targetCellId: parseStableId<"cell">(f.targetCellId), expression: text(f.expression, true),
        referenceCellIds: array(f.referenceCellIds).map(id => parseStableId<"cell">(id)),
        sourceKind: choice(f.sourceKind, ["WORKBOOK_SOURCE", "OPERATIONAL_OVERRIDE", "MAPPING"]),
        activation: choice(f.activation, ["DRAFT", "ACTIVE"]),
        provenance: p ? { workbookSha256: text(p.workbookSha256), sheet: text(p.sheet, true), address: text(p.address, true) } : null };
    }),
    policy: policyStatus === "UNCONFIGURED" ? { status: policyStatus }
      : { status: policyStatus, versionId: parseStableId<"policy">(policyObject.versionId) },
    calculationRunRefs: array(root.calculationRunRefs).map(value => {
      const r = object(value, ["id", "snapshotId", "profile", "selectedOfferRevisionId", "engineVersion", "policyVersionId", "status"]);
      return { id: parseStableId<"run">(r.id), snapshotId: parseStableId<"snapshot">(r.snapshotId),
        profile: parseProfile(r.profile), selectedOfferRevisionId: nullableId<"offer-revision">(r.selectedOfferRevisionId),
        engineVersion: text(r.engineVersion, true), policyVersionId: nullableId<"policy">(r.policyVersionId),
        status: choice(r.status, ["NOT_EVALUATED", "NONFINAL", "ERROR", "VALID"]) };
    }),
  };
  validateReferences(snapshot);
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
    ...p.offerRevisions.flatMap(r => [r.id, ...r.values.map(v => v.id)]),
    ...s.worksheets.map(w => w.id), ...tables.flatMap(t => [t.id, ...t.rows.map(r => r.id), ...t.columns.map(c => c.id)]),
    ...cells.map(c => c.id), ...s.formulas.flatMap(f => [f.id, f.versionId]), ...s.calculationRunRefs.map(r => r.id),
    ...s.mappings.flatMap(m => [m.id, m.versionId])];
  unique(allIds, "entity inventory");
  const revisions = new Set(p.offerRevisions.map(r => r.id));
  const vendors = new Set(p.vendors.map(v => v.id));
  const offers = new Set(p.offers.map(o => o.id));
  p.vendors.forEach(v => requireCondition(v.analysisId === s.analysisId, "Vendor belongs to another analysis."));
  p.offers.forEach(o => requireCondition(o.analysisId === s.analysisId && vendors.has(o.vendorId), "Invalid offer vendor/analysis reference."));
  p.offerRevisions.forEach(r => requireCondition(offers.has(r.offerId), "Invalid offer revision reference."));
  unique(p.offerRevisions.map(r => r.offerId + ":" + r.revisionNumber), "offer revision number");
  requireCondition(s.selectedOfferRevisionId === null || revisions.has(s.selectedOfferRevisionId), "Selected revision does not exist.");
  for (const t of tables) {
    sameMembers(t.rowOrder, t.rows.map(r => r.id), "row order");
    sameMembers(t.columnOrder, t.columns.map(c => c.id), "column order");
    unique(t.cells.map(c => c.rowId + ":" + c.columnId), "cell position");
    t.cells.forEach(c => requireCondition(c.tableId === t.id && t.rowOrder.includes(c.rowId) &&
      t.columnOrder.includes(c.columnId), "Cell refers to another table or missing row/column."));
  }
  const byCell = new Map(cells.map(c => [c.id, c]));
  for (const m of s.mappings) {
    const source = byCell.get(m.sourceCellId);
    const target = byCell.get(m.targetCellId);
    requireCondition(m.analysisId === s.analysisId && source && target &&
      target.scope === m.scope && (source.scope === "SHARED" || source.scope === m.scope), "Invalid mapping reference or scope.");
    requireCondition(!Object.values(s.profiles).some(p => p.hppBase.cellId === m.targetCellId), "Mapping cannot write manual HPP.");
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
    requireCondition(hpp?.scope === profile && hpp.source.kind === "INPUT", "HPP must be a manual input in its own profile.");
    requireCondition(s.worksheets.some(w => w.stage === "AHS" && w.tables.some(t => t.cells.some(c => c.id === hpp.id))), "HPP must belong to AHS.");
    const context = state.hppBase.contextRunId;
    requireCondition(context === null || s.calculationRunRefs.some(r => r.id === context && r.profile === profile), "Invalid HPP run context.");
    const review = state.reviewContext;
    if (review) {
      requireCondition(review.profile === profile, "Cross-profile review context.");
      unique(review.inputCellIds, "review inputs");
      unique(review.mappingVersionIds, "review mappings");
      requireCondition(review.selectedOfferRevisionId === null || revisions.has(review.selectedOfferRevisionId), "Missing reviewed offer revision.");
      review.inputCellIds.forEach(id => {
        const cell = byCell.get(id);
        requireCondition(cell?.source.kind === "INPUT" && (cell.scope === profile || cell.scope === "SHARED"), "Invalid reviewed input scope.");
      });
      requireCondition(review.runId === null || s.calculationRunRefs.some(r => r.id === review.runId && r.profile === profile), "Invalid reviewed run.");
      requireCondition(review.freshness !== "STALE" || review.decisionStatus === "NEEDS_REVIEW", "Stale context requires review.");
      if (review.freshness === "CURRENT") {
        requireCondition(review.selectedOfferRevisionId === s.selectedOfferRevisionId, "Current review selection mismatch.");
        review.mappingVersionIds.forEach(id => requireCondition(s.mappings.some(m => m.versionId === id &&
          (m.scope === profile || m.scope === "SHARED")), "Invalid current review mapping."));
      }
    }
  }
  s.calculationRunRefs.forEach(r => {
    requireCondition(r.selectedOfferRevisionId === null || revisions.has(r.selectedOfferRevisionId), "Run selected revision does not exist.");
    requireCondition(r.status !== "VALID" || r.policyVersionId !== null, "Valid run reference requires a policy version.");
    requireCondition(r.policyVersionId === null || !allIds.includes(r.policyVersionId), "Run policy ID is another entity kind.");
    requireCondition(!allIds.includes(r.snapshotId) || r.snapshotId === s.id, "Run snapshot ID is another entity kind.");
  });
}
