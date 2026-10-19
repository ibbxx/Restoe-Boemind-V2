import type { StableId } from "./ids.ts";
import type { Profile } from "./profiles.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";

export interface SheetPresentation {
  readonly tableId: StableId<"table">;
  readonly profile: Profile | "SHARED";
  readonly rowHeights: readonly { readonly id: StableId<"row">; readonly size: number }[];
  readonly columnWidths: readonly { readonly id: StableId<"column">; readonly size: number }[];
}
export interface CellPresentation {
  readonly cellId: StableId<"cell">;
  readonly address: string;
  readonly kind: "LABEL" | "INPUT" | "RESULT" | "BLANK";
  readonly tone: "plain" | "yellow" | "green" | "red" | "gray";
  readonly bold: boolean;
  readonly align: "left" | "center" | "right";
  readonly unit: "text" | "1" | "IDR/L" | "L" | "IDR";
}
export interface SolverSettings {
  readonly minimum: string;
  readonly maximum: string;
  readonly step: string;
}
export interface DynamicWorkbook {
  readonly template: "AHAS-v1";
  readonly sourceHash: string;
  readonly configuration: EngineConfiguration | null;
  readonly solver: SolverSettings | null;
  readonly tables: readonly SheetPresentation[];
  readonly cells: readonly CellPresentation[];
  readonly bindings: readonly { readonly profile: Profile; readonly key: string; readonly cellId: StableId<"cell"> }[];
  readonly offers: readonly { readonly columnId: StableId<"column">; readonly baseCellId: StableId<"cell">; readonly nameCellId: StableId<"cell">; readonly offerId: StableId<"offer">; readonly revisionId: StableId<"offer-revision">; readonly pattern: "C" | "D" | "E" }[];
  readonly selections: Readonly<Record<Profile, StableId<"offer-revision"> | null>>;
}

// Raw input is retained for drafts; its business validation belongs to a configured policy.
export type CellInput =
  | { readonly kind: "UNSET" }
  | { readonly kind: "TEXT"; readonly text: string }
  | { readonly kind: "NUMERIC_TEXT"; readonly text: string };

export type CellSource =
  | { readonly kind: "INPUT"; readonly input: CellInput }
  | { readonly kind: "FORMULA"; readonly formulaId: StableId<"formula"> }
  | { readonly kind: "MAPPING"; readonly mappingId: StableId<"mapping"> };

export interface CellSnapshot {
  readonly id: StableId<"cell">;
  readonly tableId: StableId<"table">;
  readonly rowId: StableId<"row">;
  readonly columnId: StableId<"column">;
  readonly scope: Profile | "SHARED";
  readonly source: CellSource;
}

export interface TableSnapshot {
  readonly id: StableId<"table">;
  readonly rows: readonly { readonly id: StableId<"row">; readonly label: string }[];
  readonly columns: readonly { readonly id: StableId<"column">; readonly label: string }[];
  readonly rowOrder: readonly StableId<"row">[];
  readonly columnOrder: readonly StableId<"column">[];
  readonly cells: readonly CellSnapshot[];
  readonly merges: readonly TableMerge[];
}

export interface TableMerge {
  readonly id: StableId<"merge">;
  readonly anchorCellId: StableId<"cell">;
  readonly rowSpan: number;
  readonly colSpan: number;
}

export interface WorksheetSnapshot {
  readonly id: StableId<"worksheet">;
  readonly stage: "EVALUASI_VENDOR" | "KONVERSI_JAGAD" | "AHS";
  readonly label: string;
  readonly tables: readonly TableSnapshot[];
}

export interface FormulaDefinition {
  readonly id: StableId<"formula">;
  readonly versionId: StableId<"formula-version">;
  readonly targetCellId: StableId<"cell">;
  readonly expression: string;
  // Declared IDs only; parsing expression dependencies belongs to Phase 3.
  readonly referenceCellIds: readonly StableId<"cell">[];
  readonly sourceKind: "WORKBOOK_SOURCE" | "OPERATIONAL_OVERRIDE" | "MAPPING";
  readonly activation: "DRAFT" | "ACTIVE";
  readonly provenance: {
    readonly workbookSha256: string;
    readonly sheet: string;
    readonly address: string;
  } | null;
}

export interface HppBase {
  readonly origin: "MANUAL" | "CONVERSION_COST";
  readonly cellId: StableId<"cell">;
  readonly contextRunId: StableId<"run"> | null;
}

export interface ProfileSnapshot {
  readonly reviewContext: ReviewContext | null;
  readonly hppBase: HppBase;
  readonly cellIds: readonly StableId<"cell">[];
  readonly formulaIds: readonly StableId<"formula">[];
}

export type CalculationPolicyRef =
  | { readonly status: "UNCONFIGURED" }
  | { readonly status: "CONFIGURED"; readonly versionId: StableId<"policy"> };

export interface WorkbookSnapshot {
  readonly schemaVersion: 2 | 3;
  readonly workbook?: DynamicWorkbook;
  readonly id: StableId<"snapshot">;
  readonly projectId: StableId<"project">;
  readonly project: Project;
  readonly analysisId: StableId<"analysis">;
  readonly analysis: AnalysisState;
  readonly mappings: readonly MappingVersion[];
  readonly selectedOfferRevisionId: StableId<"offer-revision"> | null;
  readonly activeProfile: Profile;
  readonly profiles: Readonly<Record<Profile, ProfileSnapshot>>;
  readonly worksheets: readonly WorksheetSnapshot[];
  readonly formulas: readonly FormulaDefinition[];
  readonly policy: CalculationPolicyRef;
  readonly calculationRunRefs: readonly CalculationRunReference[];
}

export interface Project {
  readonly id: StableId<"project">;
  readonly name: string;
}

export interface Analysis {
  readonly id: StableId<"analysis">;
  readonly projectId: StableId<"project">;
  readonly name: string;
}

export interface AnalysisVendor {
  readonly id: StableId<"vendor">;
  readonly analysisId: StableId<"analysis">;
  readonly name: string;
}

export interface Offer {
  readonly id: StableId<"offer">;
  readonly analysisId: StableId<"analysis">;
  readonly vendorId: StableId<"vendor">;
  readonly label: string;
}

export interface OfferRevision {
  readonly id: StableId<"offer-revision">;
  readonly offerId: StableId<"offer">;
  readonly revisionNumber: number;
  readonly values: readonly {
    readonly id: StableId<"offer-value">;
    readonly label: string;
    readonly input: CellInput;
  }[];
}

export interface AnalysisState {
  readonly analysis: Analysis;
  readonly vendors: readonly AnalysisVendor[];
  readonly offers: readonly Offer[];
  readonly offerRevisions: readonly OfferRevision[];
}

// Historical reference metadata is not proof that a calculation was correct.
export interface CalculationRunReference {
  readonly id: StableId<"run">;
  readonly snapshotId: StableId<"snapshot">;
  readonly profile: Profile;
  readonly selectedOfferRevisionId: StableId<"offer-revision"> | null;
  readonly engineVersion: string;
  readonly policyVersionId: StableId<"policy"> | null;
  readonly status: CalculationStatus;
}

export interface EvaluatedCellValue {
  readonly cellId: StableId<"cell">;
  readonly value:
    | { readonly kind: "DECIMAL"; readonly canonical: string }
    | { readonly kind: "TEXT"; readonly text: string };
}

// These are run states, not the still-unapproved EMPTY/ZERO/MISSING cell semantics.
export type CalculationRun = {
  readonly id: StableId<"run">;
  readonly snapshotId: StableId<"snapshot">;
  readonly engineVersion: string;
} & (
  | {
      readonly status: "NOT_EVALUATED" | "NONFINAL" | "ERROR";
      readonly policyVersionId: StableId<"policy"> | null;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly status: "VALID";
      readonly policyVersionId: StableId<"policy">;
      readonly values: readonly EvaluatedCellValue[];
    }
);

export type CalculationStatus = CalculationRun["status"];

export type ValidCalculationRun = Extract<CalculationRun, { readonly status: "VALID" }>;

// Structural metadata only; expressions and units do not establish business validity.
export interface MappingVersion {
  readonly id: StableId<"mapping">;
  readonly versionId: StableId<"mapping-version">;
  readonly analysisId: StableId<"analysis">;
  readonly scope: Profile | "SHARED";
  readonly sourceCellId: StableId<"cell">;
  readonly targetCellId: StableId<"cell">;
  readonly sourceComponent: string;
  readonly transformExpression: string | null;
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly status: "DRAFT" | "ACTIVE" | "REJECTED" | "NEEDS_REVIEW";
  readonly provenance: {
    readonly actorId: StableId<"user">;
    readonly changeEventId: StableId<"change-event">;
    readonly sourceRef: string | null;
    readonly reason: string | null;
  };
}

// Explicit watched inputs, not inferred formula dependencies or proof of calculation.
export interface ReviewContext {
  readonly inputCellIds: readonly StableId<"cell">[];
  readonly snapshotId: StableId<"snapshot">;
  readonly profile: Profile;
  readonly selectedOfferRevisionId: StableId<"offer-revision"> | null;
  readonly mappingVersionIds: readonly StableId<"mapping-version">[];
  readonly runId: StableId<"run"> | null;
  readonly freshness: "CURRENT" | "STALE";
  readonly decisionStatus: "DRAFT" | "CONFIRMED" | "NEEDS_REVIEW";
}
