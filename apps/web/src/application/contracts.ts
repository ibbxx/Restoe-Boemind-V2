import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";

export interface SavedWorkbook {
  readonly snapshot: WorkbookSnapshot;
  readonly configuration: EngineConfiguration | null;
  readonly version: StableId<"version">;
  readonly savedAt: string;
  readonly savedBy: StableId<"user">;
}
export interface SaveRequest {
  readonly expectedVersion: StableId<"version"> | null;
  readonly mutationId: StableId<"mutation">;
  readonly snapshot: WorkbookSnapshot;
  readonly configuration: EngineConfiguration | null;
}
export type SaveOutcome =
  | { readonly status: "SAVED"; readonly workbook: SavedWorkbook }
  | { readonly status: "CONFLICT"; readonly code: "STALE_VERSION";
      readonly expectedVersion: StableId<"version"> | null; readonly currentVersion: StableId<"version"> | null }
  | { readonly status: "REJECTED"; readonly code: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT"; readonly reason: string };
