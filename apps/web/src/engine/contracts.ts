import type { CalculationRun, WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import type { DecimalPolicy } from "./decimal.ts";

export interface CalculationEngine {
  readonly version: string;
  evaluate(snapshot: WorkbookSnapshot): CalculationRun;
}

// Empty dimensions mean dimensionless; absent metadata is never assumed dimensionless.
export type Unit = Readonly<Record<string, number>>;
export interface EngineConfiguration {
  readonly version: string;
  readonly policyVersionId: StableId<"policy">;
  readonly decimal: DecimalPolicy;
  readonly units: readonly { readonly cellId: StableId<"cell">; readonly symbol: string; readonly dimensions: Unit }[];
  readonly aggregates: readonly {
    readonly id: StableId<"aggregate">;
    readonly versionId: StableId<"aggregate-version">;
    readonly memberCellIds: readonly StableId<"cell">[];
  }[];
  // Explicit dependencies on the manually pinned offer; never an automatic selection or value binding.
  readonly selectionDependentCellIds: readonly StableId<"cell">[];
}

export type NodeResult = {
  readonly cellId: StableId<"cell">;
  readonly dependencies: readonly string[];
  readonly writer: string;
} & (
  | { readonly status: "VALUE" | "ZERO"; readonly value: string; readonly unit: Unit }
  | { readonly status: "TEXT"; readonly text: string }
  | { readonly status: "EMPTY" | "MISSING" | "INVALID" | "ERROR"; readonly code: string; readonly path: readonly string[] }
);

export interface EngineRun {
  readonly solver?: import("./inu-solver.ts").SolverResult;
  readonly provisional?: {
    readonly status: "NONFINAL" | "ERROR";
    readonly results: readonly NodeResult[];
    readonly assumedZeroCellIds: readonly string[];
    readonly assumptionsByCellId: Readonly<Record<string, readonly string[]>>;
  };
  readonly id: StableId<"run">;
  readonly snapshotId: StableId<"snapshot">;
  readonly engineVersion: string;
  readonly policyVersionId: StableId<"policy"> | null;
  readonly status: "NONFINAL" | "ERROR";
  readonly diagnostics: readonly string[];
  readonly results: readonly NodeResult[];
  readonly evaluatedCellIds: readonly string[];
  readonly manifest: {
    readonly snapshot: WorkbookSnapshot;
    readonly configuration: EngineConfiguration;
    readonly signatures: Readonly<Record<string, string>>;
  };
}
