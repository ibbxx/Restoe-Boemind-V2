import type postgres from "postgres";
import type { SavedWorkbook, SaveOutcome } from "../application/contracts.ts";
import { parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";
import { canonicalJson, freeze } from "../domain/snapshots.ts";
import { DomainValidationError, requireCondition } from "../domain/validation.ts";
import { captureSavedWorkbook, parseSaveRequest, planSave } from "./current-workbook.ts";
import type { CurrentRecord } from "./current-workbook.ts";
import { enterRuntimeRole } from "./runtime-role.ts";
import { encodeWorkbook, decodeWorkbook } from "./workbook-data.ts";

type Tx = postgres.TransactionSql;
type CurrentRow = { data: unknown; version: string; analysis_name: string; project_name: string;
  saved_at: Date; saved_by: string; mutation_id: string; request_signature: string; project_id: string };
export class AccessDeniedError extends Error {
  constructor() { super("Resource unavailable or access denied."); }
}

export class PostgresWorkbookRepository {
  readonly actorId: StableId<"user">;
  readonly timings: Record<string, number> = {};
  constructor(readonly sql: postgres.Sql, verifiedActorId: unknown) { this.actorId = parseStableId<"user">(verifiedActorId); }

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return await this.sql.begin(async tx => {
      await tx`set local statement_timeout = '15s'`;
      await enterRuntimeRole(tx);
      await tx`select set_config('request.jwt.claim.sub', ${this.actorId}, true),
        set_config('request.jwt.claims', ${JSON.stringify({ sub: this.actorId, role: "authenticated" })}, true)`;
      return await work(tx);
    }) as T;
  }

  async #current(tx: Tx, analysisId: StableId<"analysis">): Promise<CurrentRecord | null> {
    const [row] = await tx<CurrentRow[]>`select c.data, c.version, c.saved_at, c.saved_by, c.mutation_id, c.request_signature, c.project_id,
      a.name as analysis_name, p.name as project_name from procurement.current_workbooks c
      join procurement.analyses a on a.id = c.analysis_id and a.owner_id = c.owner_id
      join procurement.projects p on p.id = c.project_id and p.owner_id = c.owner_id where c.analysis_id = ${analysisId}`;
    if (!row) return null;
    const current = decodeWorkbook(row.data, { analysisId, projectId: row.project_id, analysisName: row.analysis_name, projectName: row.project_name });
    const workbook = captureSavedWorkbook({ ...current,
      version: parseStableId<"version">(row.version), savedAt: new Date(row.saved_at).toISOString(), savedBy: parseStableId<"user">(row.saved_by) });
    requireCondition(workbook.snapshot.analysisId === analysisId && workbook.snapshot.projectId === row.project_id && workbook.savedBy === this.actorId, "Invalid workbook ownership.");
    return { workbook, mutationId: parseStableId<"mutation">(row.mutation_id), signature: row.request_signature };
  }

  async current(analysisId: unknown): Promise<SavedWorkbook | null> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(async tx => (await this.#current(tx, id))?.workbook ?? null);
  }
  async listProjects() {
    return this.transaction(async tx => freeze([...(await tx<{ id: string; name: string }[]>`select id, name from procurement.projects order by id`)]));
  }
  async listAnalyses(projectId: unknown) {
    const id = parseStableId<"project">(projectId);
    return this.transaction(async tx => freeze([...(await tx<{ id: string; name: string; project_id: string }[]>`
      select id, name, project_id from procurement.analyses where project_id = ${id} order by id`)]));
  }

  async save(value: unknown, actorId: unknown): Promise<SaveOutcome> {
    const started = performance.now();
    try {
      const { request, actor, signature } = parseSaveRequest(value, actorId);
      if (actor !== this.actorId) throw new AccessDeniedError();
      this.timings.validation = performance.now() - started;
      const persistenceStarted = performance.now();
      const outcome = await this.transaction(async tx => {
        const s = request.snapshot;
        await tx`select pg_advisory_xact_lock(hashtextextended(${'project:' + s.projectId}, 0))`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + s.analysisId}, 0))`;
        const prior = await this.#current(tx, s.analysisId);
        const next = planSave(request, actor, signature, prior);
        if (!("record" in next) || next.record === prior) return next.outcome;
        await tx`insert into procurement.projects (id, owner_id, name) values (${s.projectId}, ${actor}, ${s.project.name}) on conflict (id) do nothing`;
        const [project] = await tx`select id from procurement.projects where id = ${s.projectId}`;
        if (!project) throw new AccessDeniedError();
        await tx`insert into procurement.analyses (id, project_id, owner_id, name)
          values (${s.analysisId}, ${s.projectId}, ${actor}, ${s.analysis.analysis.name}) on conflict (id) do nothing`;
        const [analysis] = await tx`select project_id from procurement.analyses where id = ${s.analysisId}`;
        if (!analysis) throw new AccessDeniedError();
        requireCondition(analysis.project_id === s.projectId, "An analysis cannot move to another project.");
        await tx`update procurement.projects set name = ${s.project.name} where id = ${s.projectId}`;
        await tx`update procurement.analyses set name = ${s.analysis.analysis.name} where id = ${s.analysisId}`;
        const w = next.record.workbook;
        const data = tx.json(JSON.parse(canonicalJson(encodeWorkbook(w.snapshot, w.configuration))));
        await tx`insert into procurement.current_workbooks
          (analysis_id, project_id, owner_id, data, version, saved_at, saved_by, mutation_id, request_signature)
          values (${s.analysisId}, ${s.projectId}, ${actor}, ${data}, ${w.version}, ${w.savedAt}, ${actor}, ${request.mutationId}, ${signature})
          on conflict (analysis_id) do update set data = excluded.data,
            version = excluded.version, saved_at = excluded.saved_at, saved_by = excluded.saved_by,
            mutation_id = excluded.mutation_id, request_signature = excluded.request_signature`;
        return next.outcome;
      });
      this.timings.persistence = performance.now() - persistenceStarted;
      return freeze(outcome);
    } catch (error) {
      if (!(error instanceof DomainValidationError || error instanceof TypeError)) throw error;
      return { status: "REJECTED", code: "INVALID_REQUEST", reason: error.message };
    }
  }
}
