import type {
  CalculationRun, ManualHppInput, MappingVersion, ReviewContext, RevisionState, ValidCalculationRun, WorkbookSnapshot,
} from "../src/domain/contracts.ts";
import type { StableId } from "../src/domain/ids.ts";

// Unused @ts-expect-error directives fail typecheck if a contract becomes permissive.
export function checkContractTypes(
  projectId: StableId<"project">,
  nonfinal: Exclude<CalculationRun, ValidCalculationRun>,
  confirmed: Extract<RevisionState, { readonly kind: "CONFIRMED" }>,
  localDraft: Extract<RevisionState, { readonly kind: "LOCAL_DRAFT" }>,
  snapshot: WorkbookSnapshot,
) {
  // @ts-expect-error Entity identity types cannot be interchanged.
  const wrongOfferId: StableId<"offer-revision"> = projectId;
  // @ts-expect-error A nonfinal run cannot be used as a confirmed result.
  const wrongConfirmedRun: ValidCalculationRun = nonfinal;
  // @ts-expect-error HPP is manual input, never a formula binding.
  const wrongHppOrigin: ManualHppInput["origin"] = "FORMULA";
  // @ts-expect-error An unsaved local draft has no saved revision ID.
  const wrongRevisionId: StableId<"revision"> = localDraft.revisionId;
  // @ts-expect-error Snapshot collections cannot be mutated through this contract.
  snapshot.worksheets.pop();
  // @ts-expect-error A project identity does not establish analysis ownership.
  const wrongAnalysis: MappingVersion["analysisId"] = projectId;
  // @ts-expect-error Mapping activation cannot be implicit.
  const wrongMappingStatus: MappingVersion["status"] = "VALID";
  // @ts-expect-error Freshness is separate from decision status.
  const wrongFreshness: ReviewContext["freshness"] = "NEEDS_REVIEW";

  const validRun: ValidCalculationRun = confirmed.run;
  const policyId: StableId<"policy"> = validRun.policyVersionId;
  return { wrongOfferId, wrongConfirmedRun, wrongHppOrigin, wrongRevisionId, wrongAnalysis,
    wrongMappingStatus, wrongFreshness, validRun, policyId };
}
