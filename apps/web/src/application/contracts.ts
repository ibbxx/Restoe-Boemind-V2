import type { SavedRevision, WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";

export interface SaveRequest {
  readonly intent: "SAVE_DRAFT" | "CONFIRM_RESULT";
  readonly expectedRevisionId: StableId<"revision"> | null;
  readonly mutationId: StableId<"mutation">;
  readonly snapshot: WorkbookSnapshot;
  readonly reason?: string;
}

export type SaveOutcome =
  | { readonly status: "SAVED"; readonly revision: SavedRevision }
  | {
      readonly status: "CONFLICT";
      readonly code: "STALE_REVISION";
      readonly expectedRevisionId: StableId<"revision"> | null;
      readonly currentRevisionId: StableId<"revision"> | null;
    }
  | {
      readonly status: "REJECTED";
      readonly code: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT" | "CONFIRMATION_UNAVAILABLE" | "INVALID_HISTORY_TRANSITION";
      readonly reason: string;
    };

export interface RestoreRequest {
  readonly reason?: string;
  readonly analysisId: StableId<"analysis">;
  readonly sourceRevisionId: StableId<"revision">;
  readonly expectedRevisionId: StableId<"revision"> | null;
  readonly mutationId: StableId<"mutation">;
}

// Identity and project permissions must come from the server session, not this request.
export interface WorkbookService {
  save(request: SaveRequest): Promise<SaveOutcome>;
}
