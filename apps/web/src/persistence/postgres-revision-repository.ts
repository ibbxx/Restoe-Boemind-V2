import type postgres from "postgres";
import type { SaveOutcome } from "../application/contracts.ts";
import type { WorkbookSnapshot } from "../domain/contracts.ts";
import { parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";
import { canonicalJson, captureSnapshot, freeze } from "../domain/snapshots.ts";
import { DomainValidationError, nullableId, requireCondition } from "../domain/validation.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { FormulaEngine } from "../engine/formula-engine.ts";
import { assertConfigurationVersions } from "../engine/graph.ts";
import { InMemoryRevisionRepository, requestWithReason } from "./in-memory-revision-repository.ts";
import type { PersistentRevisionRepository, StoredRevision } from "./contracts.ts";
import { enterRuntimeRole } from "./runtime-role.ts";

type Tx = postgres.TransactionSql;
export class AccessDeniedError extends Error {
  constructor() { super("Resource unavailable or access denied."); }
}

function json(tx: Tx, value: unknown) { return tx.json(JSON.parse(canonicalJson(value))); }

function stored(value: StoredRevision): StoredRevision {
  const snapshot = captureSnapshot(value.revision.snapshot);
  requireCondition(value.revision.kind === "SAVED_DRAFT" && value.revision.run === null &&
    value.projectId === snapshot.projectId && value.analysisId === snapshot.analysisId &&
    value.changeEvent.revisionAfterId === value.revision.revisionId && value.changeEvent.actorId === value.actorId &&
    canonicalJson(value.changeEvent.after) === canonicalJson(snapshot), "Invalid persisted revision envelope.");
  parseStableId<"revision">(value.revision.revisionId);
  parseStableId<"user">(value.actorId);
  return freeze({ ...value, revision: { ...value.revision, snapshot } });
}

// PostgreSQL supplies locking/durability; the existing repository supplies the same domain transition rules.
export class PostgresRevisionRepository implements PersistentRevisionRepository {
  readonly actorId: StableId<"user">;
  readonly sql: postgres.Sql;
  constructor(sql: postgres.Sql, verifiedActorId: unknown) {
    this.sql = sql; this.actorId = parseStableId<"user">(verifiedActorId);
  }

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return await this.sql.begin(async tx => {
      await tx`set local statement_timeout = '15s'`;
      await enterRuntimeRole(tx);
      await tx`select set_config('request.jwt.claim.sub', ${this.actorId}, true),
        set_config('request.jwt.claims', ${JSON.stringify({ sub: this.actorId, role: "authenticated" })}, true)`;
      return await work(tx);
    }) as T;
  }

  async #history(tx: Tx, analysisId: StableId<"analysis">): Promise<readonly StoredRevision[]> {
    const rows = await tx<{ payload: StoredRevision }[]>`select payload from procurement.revisions where analysis_id = ${analysisId} order by ordinal`;
    return freeze(rows.map(r => stored(r.payload)));
  }
  async history(analysisId: unknown): Promise<readonly StoredRevision[]> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(tx => this.#history(tx, id));
  }
  async head(analysisId: unknown): Promise<StoredRevision | null> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(tx => this.#head(tx, id));
  }
  async #head(tx: Tx, id: StableId<"analysis">): Promise<StoredRevision | null> {
    const [row] = await tx<{ payload: StoredRevision }[]>`select r.payload from procurement.analysis_heads h
      join procurement.revisions r on r.id = h.revision_id and r.analysis_id = h.analysis_id where h.analysis_id = ${id}`;
    return row ? stored(row.payload) : null;
  }
  async get(analysisId: unknown, revisionId: unknown): Promise<StoredRevision> {
    const analysis = parseStableId<"analysis">(analysisId), revision = parseStableId<"revision">(revisionId);
    return this.transaction(async tx => {
      const [row] = await tx<{ payload: StoredRevision }[]>`select payload from procurement.revisions where analysis_id = ${analysis} and id = ${revision}`;
      if (!row) throw new AccessDeniedError();
      return stored(row.payload);
    });
  }
  async replay(analysisId: unknown, revisionId: unknown): Promise<WorkbookSnapshot> {
    return captureSnapshot((await this.get(analysisId, revisionId)).revision.snapshot);
  }
  async listProjects() {
    return this.transaction(async tx => freeze([...(await tx<{ id: string; name: string }[]>`select id, name from procurement.projects order by id`)]));
  }
  async listAnalyses(projectId: unknown) {
    const id = parseStableId<"project">(projectId);
    return this.transaction(async tx => freeze([...(await tx<{ id: string; name: string; project_id: string }[]>`
      select id, name, project_id from procurement.analyses where project_id = ${id} order by id`)]));
  }

  async save(request: unknown, actorId: unknown): Promise<SaveOutcome> { return this.#mutate("SAVE", request, actorId); }
  async restore(request: unknown, actorId: unknown): Promise<SaveOutcome> { return this.#mutate("RESTORE", request, actorId); }

  async #mutate(operation: "SAVE" | "RESTORE", request: unknown, actorId: unknown): Promise<SaveOutcome> {
    try {
      if (parseStableId<"user">(actorId) !== this.actorId) throw new AccessDeniedError();
      const r = requestWithReason(request, operation === "SAVE" ? ["intent", "expectedRevisionId", "mutationId", "snapshot"] :
        ["analysisId", "sourceRevisionId", "expectedRevisionId", "mutationId"]);
      const proposed = operation === "SAVE" ? captureSnapshot(r.snapshot) : null;
      const analysisId = proposed?.analysisId ?? parseStableId<"analysis">(r.analysisId);
      const mutationId = parseStableId<"mutation">(r.mutationId);
      const expectedRevisionId = nullableId<"revision">(r.expectedRevisionId);
      if (operation === "SAVE") requireCondition(r.intent === "SAVE_DRAFT" || r.intent === "CONFIRM_RESULT", "Unknown save intent.");
      else parseStableId<"revision">(r.sourceRevisionId);
      const signature = canonicalJson({ operation, request: { ...r, expectedRevisionId, mutationId,
        ...(proposed ? { snapshot: proposed } : { analysisId, sourceRevisionId: parseStableId<"revision">(r.sourceRevisionId) }) }, actorId: this.actorId });
      return await this.transaction(async tx => {
        // Also serializes the first save: there may be no head row yet to lock.
        await tx`select pg_advisory_xact_lock(hashtextextended(${analysisId}, 0))`;
        const [retry] = await tx<{ request_signature: string; payload: StoredRevision }[]>`
          select m.request_signature, r.payload from procurement.revision_mutations m join procurement.revisions r
          on r.id = m.revision_id and r.analysis_id = m.analysis_id where m.analysis_id = ${analysisId} and m.mutation_id = ${mutationId}`;
        if (retry) return retry.request_signature === signature ? freeze({ status: "SAVED", revision: stored(retry.payload).revision }) :
          freeze({ status: "REJECTED", code: "IDEMPOTENCY_CONFLICT", reason: "Mutation ID was already used with another payload or actor." });
        const history = await this.#history(tx, analysisId);
        if (operation === "RESTORE" && !history.length) throw new AccessDeniedError();
        const transition = new InMemoryRevisionRepository(history);
        const outcome = operation === "SAVE" ? transition.save(request, this.actorId) : transition.restore(request, this.actorId);
        if (outcome.status !== "SAVED") return outcome;
        const next = transition.head(analysisId)!;
        await this.#persist(tx, next, history.length + 1);
        await tx`insert into procurement.revision_mutations (analysis_id, mutation_id, owner_id, request_signature, revision_id)
          values (${analysisId}, ${mutationId}, ${this.actorId}, ${signature}, ${next.revision.revisionId})`;
        return outcome;
      });
    } catch (error) {
      if (error instanceof DomainValidationError || error instanceof TypeError) return freeze({ status: "REJECTED", code: "INVALID_REQUEST", reason: error.message });
      throw error;
    }
  }

  async #persist(tx: Tx, next: StoredRevision, ordinal: number) {
    const s = next.revision.snapshot, owner = this.actorId;
    await tx`insert into procurement.projects (id, owner_id, name) values (${s.projectId}, ${owner}, ${s.project.name}) on conflict (id) do nothing`;
    const [project] = await tx`select id from procurement.projects where id = ${s.projectId}`;
    if (!project) throw new AccessDeniedError();
    // Analysis snapshots retain historical names; Save/Restore is not a Project metadata command.
    await tx`insert into procurement.analyses (id, project_id, owner_id, name)
      values (${s.analysisId}, ${s.projectId}, ${owner}, ${s.analysis.analysis.name}) on conflict (id) do nothing`;
    const [analysis] = await tx`select project_id from procurement.analyses where id = ${s.analysisId}`;
    if (!analysis || analysis.project_id !== s.projectId) throw new AccessDeniedError();
    await tx`update procurement.analyses set name = ${s.analysis.analysis.name} where id = ${s.analysisId}`;
    for (const vendor of s.analysis.vendors) {
      const rows = await tx`insert into procurement.vendors (id, analysis_id, owner_id, name)
        values (${vendor.id}, ${s.analysisId}, ${owner}, ${vendor.name}) on conflict (id) do update set name = excluded.name
        where procurement.vendors.analysis_id = excluded.analysis_id returning id`;
      if (!rows.length) throw new AccessDeniedError();
    }
    for (const offer of s.analysis.offers) {
      const rows = await tx`insert into procurement.offers (id, analysis_id, owner_id, vendor_id, label)
        values (${offer.id}, ${s.analysisId}, ${owner}, ${offer.vendorId}, ${offer.label}) on conflict (id)
        do update set label = excluded.label, vendor_id = excluded.vendor_id where procurement.offers.analysis_id = excluded.analysis_id returning id`;
      if (!rows.length) throw new AccessDeniedError();
    }
    for (const revision of s.analysis.offerRevisions) {
      await tx`insert into procurement.offer_revisions (id, analysis_id, owner_id, offer_id, revision_number, payload)
        values (${revision.id}, ${s.analysisId}, ${owner}, ${revision.offerId}, ${revision.revisionNumber}, ${json(tx, revision)}) on conflict (id) do nothing`;
      const [existing] = await tx`select payload from procurement.offer_revisions where id = ${revision.id} and analysis_id = ${s.analysisId}`;
      requireCondition(existing && canonicalJson(existing.payload) === canonicalJson(revision), "Offer revision cannot be rewritten or moved.");
    }
    for (const mapping of s.mappings) {
      await tx`insert into procurement.mapping_versions (version_id, mapping_id, analysis_id, owner_id, scope, status, payload)
        values (${mapping.versionId}, ${mapping.id}, ${s.analysisId}, ${owner}, ${mapping.scope}, ${mapping.status}, ${json(tx, mapping)}) on conflict (version_id) do nothing`;
      const [existing] = await tx`select payload from procurement.mapping_versions where version_id = ${mapping.versionId} and analysis_id = ${s.analysisId}`;
      requireCondition(existing && canonicalJson(existing.payload) === canonicalJson(mapping), "Mapping version cannot be rewritten or moved.");
    }
    for (const formula of s.formulas) {
      await tx`insert into procurement.formula_versions (version_id, formula_id, analysis_id, owner_id, payload)
        values (${formula.versionId}, ${formula.id}, ${s.analysisId}, ${owner}, ${json(tx, formula)}) on conflict (version_id) do nothing`;
      const [existing] = await tx`select payload from procurement.formula_versions where version_id = ${formula.versionId} and analysis_id = ${s.analysisId}`;
      requireCondition(existing && canonicalJson(existing.payload) === canonicalJson(formula), "Formula version cannot be rewritten or moved.");
    }
    for (const reference of s.calculationRunRefs) {
      const [row] = await tx<{ payload: EngineRun }[]>`select payload from procurement.calculation_runs where id = ${reference.id} and analysis_id = ${s.analysisId}`;
      const run = row?.payload;
      requireCondition(run && reference.snapshotId === run.snapshotId && reference.engineVersion === run.engineVersion &&
        reference.policyVersionId === run.policyVersionId && reference.profile === run.manifest.snapshot.activeProfile &&
        reference.selectedOfferRevisionId === run.manifest.snapshot.selectedOfferRevisionId && reference.status === run.status,
      "Run reference requires a persisted engine manifest with the exact context.");
    }
    await tx`insert into procurement.workbook_snapshots (id, analysis_id, owner_id, payload) values (${s.id}, ${s.analysisId}, ${owner}, ${json(tx, s)})`;
    await tx`insert into procurement.revisions (id, analysis_id, owner_id, snapshot_id, parent_revision_id, ordinal, payload)
      values (${next.revision.revisionId}, ${s.analysisId}, ${owner}, ${s.id}, ${next.revision.parentRevisionId}, ${ordinal}, ${json(tx, next)})`;
    await tx`insert into procurement.change_events (id, analysis_id, owner_id, revision_id, payload)
      values (${next.changeEvent.id}, ${s.analysisId}, ${owner}, ${next.revision.revisionId}, ${json(tx, next.changeEvent)})`;
    await tx`insert into procurement.analysis_heads (analysis_id, owner_id, revision_id) values (${s.analysisId}, ${owner}, ${next.revision.revisionId})
      on conflict (analysis_id) do update set revision_id = excluded.revision_id`;
  }

  async calculate(analysisId: unknown, revisionId: unknown, configuration: EngineConfiguration) {
    const revision = (await this.get(analysisId, revisionId)).revision;
    const engine = new FormulaEngine(configuration), run = engine.evaluateRevision(revision);
    return this.persistRun(run, engine);
  }

  async persistRun(run: EngineRun, engine: FormulaEngine): Promise<{ status: "STORED_PREVIEW"; run: EngineRun } | { status: "STALE_RUN" }> {
    return this.transaction(async tx => {
      const analysisId = run.manifest.snapshot.analysisId;
      await tx`select pg_advisory_xact_lock(hashtextextended(${analysisId}, 0))`;
      const head = await this.#head(tx, analysisId);
      if (!head || !engine.canPublish(run, head.revision)) return { status: "STALE_RUN" };
      const configurations = await tx<{ configuration: EngineConfiguration }[]>`
        select payload->'manifest'->'configuration' as configuration from procurement.calculation_runs where analysis_id = ${analysisId}`;
      configurations.forEach(row => assertConfigurationVersions(row.configuration, run.manifest.configuration));
      const inserted = await tx`insert into procurement.calculation_runs (id, analysis_id, owner_id, revision_id, snapshot_id, profile, engine_version, policy_version_id, payload)
        values (${run.id}, ${analysisId}, ${this.actorId}, ${head.revision.revisionId}, ${run.snapshotId}, ${head.revision.snapshot.activeProfile},
          ${run.engineVersion}, ${run.policyVersionId}, ${json(tx, run)}) on conflict (id) do nothing returning id`;
      const [existing] = await tx`select payload from procurement.calculation_runs where analysis_id = ${analysisId} and id = ${run.id}`;
      requireCondition(existing && canonicalJson(existing.payload) === canonicalJson(run), "Calculation run cannot be rewritten.");
      // Retrying an older immutable run must not roll the latest pointer back on the same revision.
      if (!inserted.length) return freeze({ status: "STORED_PREVIEW", run });
      await tx`insert into procurement.latest_calculation_runs (analysis_id, profile, owner_id, run_id)
        values (${analysisId}, ${head.revision.snapshot.activeProfile}, ${this.actorId}, ${run.id}) on conflict (analysis_id, profile) do update set run_id = excluded.run_id`;
      return freeze({ status: "STORED_PREVIEW", run });
    });
  }
  async runs(analysisId: unknown): Promise<readonly EngineRun[]> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(async tx => freeze((await tx<{ payload: EngineRun }[]>`
      select payload from procurement.calculation_runs where analysis_id = ${id} order by created_at, id`).map(row => row.payload)));
  }
  async latestRun(analysisId: unknown, profile: "INU" | "SOLAR_BAWAH"): Promise<EngineRun | null> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(async tx => {
      const [row] = await tx<{ payload: EngineRun }[]>`select r.payload from procurement.latest_calculation_runs p
        join procurement.calculation_runs r on r.analysis_id = p.analysis_id and r.id = p.run_id
        join procurement.analysis_heads h on h.analysis_id = r.analysis_id and h.revision_id = r.revision_id
        where p.analysis_id = ${id} and p.profile = ${profile}`;
      return row ? freeze(row.payload) : null;
    });
  }
}
