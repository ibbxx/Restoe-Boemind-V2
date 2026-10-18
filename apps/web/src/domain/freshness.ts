import type { CellSnapshot, WorkbookSnapshot } from "./contracts.ts";
import { PROFILES } from "./profiles.ts";
import { canonicalJson } from "./snapshots.ts";

// Follow declared writers transitively; engine additionally validates parsed references and memberships.
export function invalidateReviewContexts(before: WorkbookSnapshot, after: WorkbookSnapshot): WorkbookSnapshot {
  const beforeCells = new Map<string, CellSnapshot>(before.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).map(c => [c.id, c]));
  const afterCells = new Map<string, CellSnapshot>(after.worksheets.flatMap(w => w.tables).flatMap(t => t.cells).map(c => [c.id, c]));
  const profiles = { ...after.profiles };
  for (const profile of PROFILES) {
    const context = profiles[profile].reviewContext;
    if (!context) continue;
    if (context.freshness === "CURRENT" && context.snapshotId === after.id && after.id !== before.id) continue;
    const previous = before.profiles[profile].reviewContext;
    const stillStale = previous?.freshness === "STALE" && previous.snapshotId === context.snapshotId;
    const offer = before.analysis.offerRevisions.find(r => r.id === context.selectedOfferRevisionId)?.offerId;
    const offerChanged = offer !== undefined && canonicalJson(before.analysis.offerRevisions.filter(r => r.offerId === offer)) !==
      canonicalJson(after.analysis.offerRevisions.filter(r => r.offerId === offer));
    const mappingChanged = context.mappingVersionIds.some(id => {
      const prior = before.mappings.find(m => m.versionId === id);
      return prior && canonicalJson(prior) !== canonicalJson(after.mappings.find(m => m.id === prior.id) ?? null);
    });
    const watched = new Set<string>(context.inputCellIds);
    const queue = [...before.formulas, ...after.formulas].filter(f => f.activation === "ACTIVE" &&
      (before.profiles[profile].formulaIds.includes(f.id) || after.profiles[profile].formulaIds.includes(f.id))).map(f => f.targetCellId as string);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      if (watched.has(id)) continue;
      watched.add(id);
      for (const snapshot of [before, after]) {
        queue.push(...snapshot.formulas.filter(f => f.targetCellId === id && f.activation === "ACTIVE").flatMap(f => f.referenceCellIds),
          ...snapshot.mappings.filter(m => m.targetCellId === id && m.status === "ACTIVE").map(m => m.sourceCellId));
      }
    }
    const inputChanged = [...watched].some(id => canonicalJson(beforeCells.get(id)?.source ?? null) !==
      canonicalJson(afterCells.get(id)?.source ?? null));
    const upstreamWriterChanged = [...watched].some(id => canonicalJson(before.formulas.filter(f => f.targetCellId === id)) !==
      canonicalJson(after.formulas.filter(f => f.targetCellId === id)) ||
      canonicalJson(before.mappings.filter(m => m.targetCellId === id && m.status === "ACTIVE" && beforeCells.get(id)?.source.kind === "MAPPING")) !==
      canonicalJson(after.mappings.filter(m => m.targetCellId === id && m.status === "ACTIVE" && afterCells.get(id)?.source.kind === "MAPPING")));
    const formulaChanged = canonicalJson(before.formulas.filter(f => before.profiles[profile].formulaIds.includes(f.id))) !==
      canonicalJson(after.formulas.filter(f => after.profiles[profile].formulaIds.includes(f.id)));
    const selectedRevision = after.workbook ? after.workbook.selections[profile] : after.selectedOfferRevisionId;
    const configurationChanged = canonicalJson(before.workbook?.configuration?.units.filter(u => watched.has(u.cellId)) ?? null) !==
      canonicalJson(after.workbook?.configuration?.units.filter(u => watched.has(u.cellId)) ?? null) ||
      (profile === "INU" && canonicalJson(before.workbook?.solver ?? null) !== canonicalJson(after.workbook?.solver ?? null));
    if (stillStale || context.selectedOfferRevisionId !== selectedRevision || offerChanged || mappingChanged || inputChanged || upstreamWriterChanged || formulaChanged || configurationChanged ||
      canonicalJson(before.policy) !== canonicalJson(after.policy) ||
      before.profiles[profile].hppBase.contextRunId !== after.profiles[profile].hppBase.contextRunId) {
      profiles[profile] = { ...profiles[profile], reviewContext: { ...context, freshness: "STALE", decisionStatus: "NEEDS_REVIEW" } };
    }
  }
  return { ...after, profiles };
}
