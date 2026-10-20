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
import { analysisPeriod } from "../domain/analysis-creation.ts";
import { ANALYSIS_STATUSES } from "../domain/analysis-status.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";

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
    return this.transaction(async tx => freeze((await tx<{ id: string; name: string; project_id: string; status: AnalysisStatus; data: unknown; project_name: string }[]>`
      select a.id, a.name, a.project_id, a.status, c.data, p.name as project_name
      from procurement.analyses a
      join procurement.current_workbooks c on c.analysis_id = a.id and c.owner_id = a.owner_id
      join procurement.projects p on p.id = a.project_id and p.owner_id = a.owner_id
      where a.project_id = ${id} order by a.id`).map(row => {
        const decoded = decodeWorkbook(row.data, { analysisId: row.id, projectId: row.project_id, analysisName: row.name, projectName: row.project_name });
        const date = decoded.snapshot.worksheets.find(w => w.stage === "AHS")?.tables.flatMap(t => t.cells.map(cell => ({ cell, label: t.rows.find(r => r.id === cell.rowId)?.label,
          address: decoded.snapshot.workbook?.cells.find(presentation => presentation.cellId === cell.id)?.address }))).find(item =>
          item.label === "Tgl Analisis (Rn)" || item.address === (item.cell.scope === "INU" ? "H4" : "H3"))?.cell;
        const value = date?.source.kind === "INPUT" && date.source.input.kind === "TEXT" ? date.source.input.text : "";
        const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
        const period = match ? analysisPeriod(`${match[3]}-${match[2]}-${match[1]}`) : "";
        return { id: row.id, name: row.name, project_id: row.project_id, status: row.status, period: period || null };
      })));
  }

  async updateAnalysis(value: unknown, actorId: unknown, name: unknown, status: unknown) {
    const analysisId = parseStableId<"analysis">(value);
    const actor = parseStableId<"user">(actorId);
    requireCondition(actor === this.actorId, "Resource unavailable or access denied.");
    requireCondition(typeof name === "string" && name.trim().length > 0, "Nama analisis wajib diisi.");
    requireCondition(typeof status === "string" && ANALYSIS_STATUSES.includes(status as AnalysisStatus), "Status analisis tidak valid.");
    return this.transaction(async tx => {
      const [updated] = await tx<{ id: string; name: string; status: AnalysisStatus }[]>`
        update procurement.analyses set name = ${name.trim()}, status = ${status}
        where id = ${analysisId} and owner_id = ${actor} returning id, name, status`;
      if (!updated) throw new AccessDeniedError();
      return { ...updated };
    });
  }

  async deleteAnalysis(value: unknown, actorId: unknown) {
    const analysisId = parseStableId<"analysis">(value);
    const actor = parseStableId<"user">(actorId);
    if (actor !== this.actorId) throw new AccessDeniedError();
    return this.transaction(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + analysisId}, 0))`;
      await tx`delete from procurement.current_workbooks where analysis_id = ${analysisId} and owner_id = ${actor}`;
      const [deleted] = await tx<{ id: string }[]>`delete from procurement.analyses where id = ${analysisId} and owner_id = ${actor} returning id`;
      if (!deleted) throw new AccessDeniedError();
      return { deleted: true as const, analysisId: deleted.id };
    });
  }

  async deleteProject(value: unknown, actorId: unknown) {
    const projectId = parseStableId<"project">(value);
    const actor = parseStableId<"user">(actorId);
    if (actor !== this.actorId) throw new AccessDeniedError();
    return this.transaction(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'project:' + projectId}, 0))`;
      await tx`delete from procurement.current_workbooks where project_id = ${projectId} and owner_id = ${actor}`;
      await tx`delete from procurement.analyses where project_id = ${projectId} and owner_id = ${actor}`;
      const [deleted] = await tx<{ id: string }[]>`delete from procurement.projects where id = ${projectId} and owner_id = ${actor} returning id`;
      if (!deleted) throw new AccessDeniedError();
      return { deleted: true as const, projectId: deleted.id };
    });
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
