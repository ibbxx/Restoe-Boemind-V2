import type { WorkbookSnapshot } from "./contracts.ts";
import { createStableId, parseStableId } from "./ids.ts";
import { canonicalJson } from "./snapshots.ts";
import { changeWorkbook } from "./workflow.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import type { DecimalPolicy } from "../engine/decimal.ts";

export const OPERATIONAL_DECIMAL_POLICY: DecimalPolicy = Object.freeze({
  scale: 18, rounding: "HALF_UP", roundAt: "EVERY_OPERATION",
});
// Stable across reloads and compatible with legacy policy references.
export const OPERATIONAL_POLICY_VERSION_ID = parseStableId<"policy">("4dec1880-3c0e-4b26-9a3d-0f69e3347d18");

export function prepareCalculationPolicy(snapshot: WorkbookSnapshot, configuration: EngineConfiguration | null) {
  if (!configuration) return { snapshot, configuration };
  const policyMatches = configuration.policyVersionId === OPERATIONAL_POLICY_VERSION_ID &&
    canonicalJson(configuration.decimal) === canonicalJson(OPERATIONAL_DECIMAL_POLICY);
  const snapshotMatches = snapshot.policy.status === "CONFIGURED" && snapshot.policy.versionId === OPERATIONAL_POLICY_VERSION_ID;
  if (policyMatches && snapshotMatches) return { snapshot, configuration };
  const next: EngineConfiguration = policyMatches ? configuration : {
    ...configuration, version: createStableId<"policy">(), policyVersionId: OPERATIONAL_POLICY_VERSION_ID,
    decimal: OPERATIONAL_DECIMAL_POLICY,
  };
  return {
    snapshot: snapshotMatches && !snapshot.workbook ? snapshot : changeWorkbook(snapshot, {
      policy: { status: "CONFIGURED", versionId: OPERATIONAL_POLICY_VERSION_ID },
      ...(snapshot.workbook ? { workbook: { ...snapshot.workbook, configuration: next } } : {}),
    }),
    configuration: next,
  };
}
