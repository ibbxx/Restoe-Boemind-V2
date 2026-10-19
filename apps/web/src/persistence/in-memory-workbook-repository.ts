import type { SaveOutcome, SavedWorkbook } from "../application/contracts.ts";
import { parseStableId } from "../domain/ids.ts";
import { freeze } from "../domain/snapshots.ts";
import { DomainValidationError } from "../domain/validation.ts";
import type { WorkbookRepository } from "./contracts.ts";
import { parseSaveRequest, planSave } from "./current-workbook.ts";
import type { CurrentRecord } from "./current-workbook.ts";

export class InMemoryWorkbookRepository implements WorkbookRepository {
  #current = new Map<string, CurrentRecord>();

  current(analysisId: unknown): SavedWorkbook | null {
    return this.#current.get(parseStableId<"analysis">(analysisId))?.workbook ?? null;
  }

  save(value: unknown, actorId: unknown): SaveOutcome {
    try {
      const { request, actor, signature } = parseSaveRequest(value, actorId);
      const prior = this.#current.get(request.snapshot.analysisId) ?? null;
      if (prior && prior.workbook.savedBy !== actor) return { status: "REJECTED", code: "INVALID_REQUEST", reason: "Resource unavailable." };
      const next = planSave(request, actor, signature, prior);
      if ("record" in next) this.#current.set(request.snapshot.analysisId, freeze(next.record));
      return freeze(next.outcome);
    } catch (error) {
      if (!(error instanceof DomainValidationError || error instanceof TypeError)) throw error;
      return { status: "REJECTED", code: "INVALID_REQUEST", reason: error.message };
    }
  }
}
