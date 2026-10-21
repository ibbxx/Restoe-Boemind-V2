import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";

export interface AnalysisMetadata {
  readonly id: string;
  readonly name: string;
  readonly status: AnalysisStatus;
  readonly version: StableId<"version">;
}
export interface AnalysisListItem extends AnalysisMetadata {
  readonly project_id: string;
  readonly period: string | null;
}
export interface AnalysisPage {
  readonly items: readonly AnalysisListItem[];
  readonly total: number;
  readonly periods: readonly string[];
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
}
export type AnalysisUpdateOutcome = AnalysisMetadata | Exclude<SaveOutcome, { status: "SAVED" }>;

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
