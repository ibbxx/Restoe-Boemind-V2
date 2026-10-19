import type { OfferRevision, WorkbookSnapshot } from "./contracts.ts";
import { captureSnapshot, canonicalJson } from "./snapshots.ts";
import { createStableId } from "./ids.ts";
import type { StableId } from "./ids.ts";
import { requireCondition } from "./validation.ts";

// Legacy fields remain readable, but the active workbook contains no historical run or vendor versions.
export function currentSnapshot(value: unknown): WorkbookSnapshot {
  const s = captureSnapshot(value);
  const latest = new Map<StableId<"offer">, OfferRevision>();
  for (const revision of s.analysis.offerRevisions) {
    if ((latest.get(revision.offerId)?.revisionNumber ?? 0) < revision.revisionNumber) latest.set(revision.offerId, revision);
  }
  const currentRevision = (id: StableId<"offer-revision"> | null) => {
    if (!id) return null;
    const revision = s.analysis.offerRevisions.find(r => r.id === id);
    requireCondition(revision, "Selected offer does not exist.");
    return latest.get(revision.offerId)!.id;
  };
  const mappings = s.mappings.map(mapping => {
    const prior = s.analysis.offerRevisions.find(r => r.id === mapping.provenance.sourceRef);
    if (!prior || latest.get(prior.offerId)!.id === prior.id) return mapping;
    const selected = latest.get(prior.offerId)!;
    let sourceComponent = mapping.sourceComponent;
    if (sourceComponent.startsWith("offer-value:")) {
      const previousValue = prior.values.find(v => sourceComponent === `offer-value:${v.id}`);
      const currentValue = selected.values.find(v => v.label === previousValue?.label);
      requireCondition(currentValue, "Current vendor component is missing.");
      sourceComponent = `offer-value:${currentValue.id}`;
    }
    return { ...mapping, versionId: createStableId<"mapping-version">(), sourceComponent,
      provenance: { ...mapping.provenance, sourceRef: selected.id } };
  });
  const next = { ...s, analysis: { ...s.analysis, offerRevisions: [...latest.values()] },
    selectedOfferRevisionId: currentRevision(s.selectedOfferRevisionId), mappings, calculationRunRefs: [],
    profiles: { INU: { ...s.profiles.INU, reviewContext: null, hppBase: { ...s.profiles.INU.hppBase, contextRunId: null } },
      SOLAR_BAWAH: { ...s.profiles.SOLAR_BAWAH, reviewContext: null, hppBase: { ...s.profiles.SOLAR_BAWAH.hppBase, contextRunId: null } } },
    ...(s.workbook ? { workbook: { ...s.workbook,
      offers: s.workbook.offers.map(o => ({ ...o, revisionId: latest.get(o.offerId)!.id })),
      selections: { INU: currentRevision(s.workbook.selections.INU), SOLAR_BAWAH: currentRevision(s.workbook.selections.SOLAR_BAWAH) } } } : {}) };
  return canonicalJson(next) === canonicalJson(s) ? s : captureSnapshot({ ...next, id: createStableId<"snapshot">() });
}
