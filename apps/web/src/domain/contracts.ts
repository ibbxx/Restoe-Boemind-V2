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
  readonly offers: readonly { readonly columnId: StableId<"column">; readonly baseCellId: StableId<"cell">; readonly nameCellId: StableId<"cell">; readonly offerId: StableId<"offer">; readonly pattern: "C" | "D" | "E" }[];
  readonly selections: Readonly<Record<Profile, StableId<"offer"> | null>>;
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
  readonly stage: "EVALUASI_VENDOR" | "KONVERSI_JAGAD" | "AHS" | "AHS_EXTERNAL";
  readonly label: string;
  readonly tables: readonly TableSnapshot[];
}

export interface FormulaDefinition {
  readonly id: StableId<"formula">;
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
}

export interface ProfileSnapshot {
  readonly hppBase: HppBase;
  readonly cellIds: readonly StableId<"cell">[];
  readonly formulaIds: readonly StableId<"formula">[];
}

export type CalculationPolicyRef =
  | { readonly status: "UNCONFIGURED" }
  | { readonly status: "CONFIGURED"; readonly versionId: StableId<"policy"> };

export type WorksheetView = "INTERNAL" | "EXTERNAL";

export interface WorkbookSnapshot {
  readonly externalAhs?: { readonly cells: readonly CellPresentation[]; readonly groups: readonly AhsGroup[]; readonly fields: readonly AhsField[];
    readonly sourceFingerprints?: Readonly<Partial<Record<Profile, string>>> };
  readonly ahsGroups?: readonly AhsGroup[];
  readonly ahsFields?: readonly AhsField[];
  readonly schemaVersion: 2 | 3;
  readonly workbook?: DynamicWorkbook;
  readonly id: StableId<"snapshot">;
  readonly projectId: StableId<"project">;
  readonly project: Project;
  readonly analysisId: StableId<"analysis">;
  readonly analysis: AnalysisState;
  readonly mappings: readonly MappingDefinition[];
  readonly selectedOfferId: StableId<"offer"> | null;
  readonly activeProfile: Profile;
  readonly profiles: Readonly<Record<Profile, ProfileSnapshot>>;
  readonly worksheets: readonly WorksheetSnapshot[];
  readonly formulas: readonly FormulaDefinition[];
  readonly policy: CalculationPolicyRef;
}

export interface AhsItem {
  readonly name: string;
  readonly builtin: boolean;
  readonly labelCellId: StableId<"cell"> | null;
  readonly priceCellId: StableId<"cell">;
  readonly volumeCellId: StableId<"cell">;
  readonly totalCellId: StableId<"cell">;
}

export interface AhsGroup {
  readonly section?: AhsGroupSection;
  readonly id: StableId<"ahs-group">;
  readonly profile: Profile;
  readonly name: string;
  readonly builtin: boolean;
  readonly labelCellId: StableId<"cell"> | null;
  readonly items: readonly AhsItem[];
}

export type AhsGroupSection = "PENDAPATAN" | "BIAYA";
export type AhsSection = "INFORMASI" | AhsGroupSection | "LABA";
export type AhsValueType = "TEXT" | "NUMBER" | "IDR" | "IDR/L" | "PERCENT";
export interface AhsField {
  readonly section: "INFORMASI" | "LABA";
  readonly profile: Profile;
  readonly name: string;
  readonly labelCellId: StableId<"cell">;
  readonly valueCellId: StableId<"cell">;
  readonly valueType: AhsValueType;
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
}

// Structural metadata only; expressions and units do not establish business validity.
export interface MappingDefinition {
  readonly id: StableId<"mapping">;
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
    readonly sourceRef: string | null;
    readonly reason: string | null;
  };
}
