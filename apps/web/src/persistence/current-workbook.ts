import { createHash } from "node:crypto";
import type { SaveOutcome, SavedWorkbook, SaveRequest } from "../application/contracts.ts";
import { currentSnapshot } from "../domain/current-workbook.ts";
import { createStableId, parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";
import { canonicalJson, captureSnapshot, freeze } from "../domain/snapshots.ts";
import { nullableId, object, requireCondition } from "../domain/validation.ts";
import type { EngineConfiguration } from "../engine/contracts.ts";
import { captureConfiguration, compileGraph } from "../engine/graph.ts";
import { encodeWorkbook } from "./workbook-data.ts";

function storedContent(snapshot: SaveRequest["snapshot"], configuration: SaveRequest["configuration"]) {
  const data = encodeWorkbook(snapshot, configuration);
  const { id, ...state } = data.state;
  void id;
  return canonicalJson({ ...data, state });
}

export interface CurrentRecord {
  readonly workbook: SavedWorkbook;
  readonly mutationId: StableId<"mutation">;
  readonly signature: string;
}

export function parseSaveRequest(value: unknown, actorId: unknown) {
  const r = object(value, ["expectedVersion", "mutationId", "snapshot", "configuration"]);
  const actor = parseStableId<"user">(actorId);
  const original = captureSnapshot(r.snapshot);
  const configuration = r.configuration === null ? null : captureConfiguration(r.configuration as EngineConfiguration);
  requireCondition(!original.workbook || canonicalJson(original.workbook.configuration) === canonicalJson(configuration), "Snapshot/configuration mismatch.");
  requireCondition(configuration ? original.policy.status === "CONFIGURED" && original.policy.versionId === configuration.policyVersionId
    : original.policy.status === "UNCONFIGURED", "Calculation policy mismatch.");
  if (configuration) compileGraph(original, configuration);
  const request: SaveRequest = { expectedVersion: nullableId<"version">(r.expectedVersion),
    mutationId: parseStableId<"mutation">(r.mutationId), snapshot: original, configuration };
  const signature = createHash("sha256").update(canonicalJson({ ...request, actorId: actor })).digest("hex");
  return { request, actor, signature };
}

export function planSave(request: SaveRequest, actor: StableId<"user">, signature: string, prior: CurrentRecord | null):
  { record: CurrentRecord; outcome: Extract<SaveOutcome, { status: "SAVED" }> } | { outcome: Exclude<SaveOutcome, { status: "SAVED" }> } {
  if (prior?.mutationId === request.mutationId) {
    if (prior.signature !== signature) return { outcome: { status: "REJECTED", code: "IDEMPOTENCY_CONFLICT", reason: "Mutation ID already used with another request." } };
    return { record: prior, outcome: { status: "SAVED", workbook: prior.workbook } };
  }
  const currentVersion = prior?.workbook.version ?? null;
  if (request.expectedVersion !== currentVersion) return { outcome: { status: "CONFLICT", code: "STALE_VERSION", expectedVersion: request.expectedVersion, currentVersion } };
  requireCondition(!prior || prior.workbook.snapshot.projectId === request.snapshot.projectId, "An analysis cannot move to another project.");
  requireCondition(!prior || (prior.workbook.snapshot.project.name === request.snapshot.project.name &&
    prior.workbook.snapshot.analysis.analysis.name === request.snapshot.analysis.analysis.name), "Use the metadata operation to rename an existing analysis.");
  const snapshot = currentSnapshot(request.snapshot);
  if (prior && storedContent(snapshot, request.configuration) === storedContent(prior.workbook.snapshot, prior.workbook.configuration)) {
    return { record: { workbook: prior.workbook, mutationId: request.mutationId, signature }, outcome: { status: "SAVED", workbook: prior.workbook } };
  }
  const workbook: SavedWorkbook = freeze({ snapshot, configuration: request.configuration,
    version: createStableId<"version">(), savedAt: new Date().toISOString(), savedBy: actor });
  return { record: { workbook, mutationId: request.mutationId, signature }, outcome: { status: "SAVED", workbook } };
}

export function captureSavedWorkbook(value: SavedWorkbook): SavedWorkbook {
  const snapshot = currentSnapshot(value.snapshot);
  const configuration = value.configuration === null ? null : captureConfiguration(value.configuration);
  requireCondition(!snapshot.workbook || canonicalJson(snapshot.workbook.configuration) === canonicalJson(configuration), "Invalid stored configuration.");
  requireCondition(configuration ? snapshot.policy.status === "CONFIGURED" && snapshot.policy.versionId === configuration.policyVersionId
    : snapshot.policy.status === "UNCONFIGURED", "Invalid stored policy.");
  if (configuration) compileGraph(snapshot, configuration);
  requireCondition(typeof value.savedAt === "string" && Number.isFinite(Date.parse(value.savedAt)), "Invalid save timestamp.");
  return freeze({ snapshot, configuration, version: parseStableId<"version">(value.version), savedBy: parseStableId<"user">(value.savedBy), savedAt: value.savedAt });
}
