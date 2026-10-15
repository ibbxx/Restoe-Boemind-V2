import type { ChangeEvent, SavedRevision, WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import type { SaveOutcome } from "../application/contracts.ts";

// Stored domain envelope shared by process-local and PostgreSQL repositories.
export interface StoredRevision {
  readonly projectId: StableId<"project">;
  readonly analysisId: StableId<"analysis">;
  readonly actorId: StableId<"user">;
  readonly mutationId: StableId<"mutation">;
  readonly revision: SavedRevision;
  readonly changeEvent: ChangeEvent;
}

export interface RevisionRepository {
  save(request: unknown, actorId: unknown): SaveOutcome;
  restore(request: unknown, actorId: unknown): SaveOutcome;
  head(analysisId: unknown): StoredRevision | null;
  get(analysisId: unknown, revisionId: unknown): StoredRevision;
  history(analysisId: unknown): readonly StoredRevision[];
  replay(analysisId: unknown, revisionId: unknown): WorkbookSnapshot;
}

export type PersistentRevisionRepository = {
  [Method in keyof RevisionRepository]: (...args: Parameters<RevisionRepository[Method]>) => Promise<ReturnType<RevisionRepository[Method]>>;
};
