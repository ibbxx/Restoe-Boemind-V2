import type postgres from "postgres";
import { createHash } from "node:crypto";
import type { AnalysisListItem, AnalysisPage, AnalysisUpdateOutcome, AnalysisMetadata, LoadedWorkbook, SavedWorkbook, SaveOutcome } from "../application/contracts.ts";
import { createStableId, parseStableId } from "../domain/ids.ts";
import type { StableId } from "../domain/ids.ts";
import { canonicalJson, freeze } from "../domain/snapshots.ts";
import { DomainValidationError, requireCondition } from "../domain/validation.ts";
import { captureSavedWorkbook, parseSaveRequest, planSave } from "./current-workbook.ts";
import type { CurrentRecord } from "./current-workbook.ts";
import { enterRuntimeRole, WorkbookUpgradeRequiredError } from "./runtime-role.ts";
import { encodeWorkbook, decodeWorkbook } from "./workbook-data.ts";
import { parseAnalysisList } from "./analysis-list.ts";
import type { AnalysisListQuery } from "./analysis-list.ts";
import { ANALYSIS_STATUSES } from "../domain/analysis-status.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";

type Tx = postgres.TransactionSql;
const SHARED_WORKSPACE_OWNER_ID = "00000000-0000-4000-8000-000000000001" as StableId<"user">;
type CurrentRow = { data: unknown; version: string; analysis_name: string; analysis_status: AnalysisStatus; project_name: string;
  saved_at: Date; saved_by: string; mutation_id: string; request_signature: string; project_id: string };
export class AccessDeniedError extends Error {
  constructor() { super("Resource unavailable or access denied."); }
}

export class PostgresWorkbookRepository {
  readonly actorId: StableId<"user">;
  readonly timings: Record<string, number> = {};
  constructor(readonly sql: postgres.Sql, verifiedActorId: unknown) { this.actorId = parseStableId<"user">(verifiedActorId); }

  async #timed<T>(name: string, work: () => T | PromiseLike<T>): Promise<T> {
    const started = performance.now();
    try { return await work(); }
    finally { this.timings[name] = (this.timings[name] ?? 0) + performance.now() - started; }
  }

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const started = performance.now();
    let finished: number | undefined;
    try {
      return await this.sql.begin(async tx => {
        // Includes pool wait, connection setup and BEGIN, not just SQL execution.
        this.timings.db_connect = performance.now() - started;
        try {
          await enterRuntimeRole(tx, this.timings);
          await this.#timed("db_claims", () => tx`select set_config('request.jwt.claim.sub', ${this.actorId}, true),
            set_config('request.jwt.claims', ${JSON.stringify({ sub: this.actorId, role: "authenticated" })}, true)`);
          return await work(tx);
        } finally { finished = performance.now(); }
      }) as T;
    } finally {
      this.timings.db_transaction = performance.now() - started;
      if (finished !== undefined) this.timings.db_finish = performance.now() - finished;
    }
  }

  async #current(tx: Tx, analysisId: StableId<"analysis">): Promise<(CurrentRecord & { analysisMetadata: AnalysisMetadata }) | null> {
    const [row] = await this.#timed("db_query", () => tx<CurrentRow[]>`select c.data, c.version, c.saved_at, c.saved_by, c.mutation_id, c.request_signature, c.project_id,
      a.name as analysis_name, a.status as analysis_status, p.name as project_name from procurement.current_workbooks c
      join procurement.analyses a on a.id = c.analysis_id and a.owner_id = c.owner_id
      join procurement.projects p on p.id = c.project_id and p.owner_id = c.owner_id where c.analysis_id = ${analysisId}`);
    if (!row) return null;
    const current = await this.#timed("decode", () => decodeWorkbook(row.data, { analysisId, projectId: row.project_id, analysisName: row.analysis_name, projectName: row.project_name }));
    const workbook = await this.#timed("stored_validation", () => captureSavedWorkbook({ ...current,
      version: parseStableId<"version">(row.version), savedAt: new Date(row.saved_at).toISOString(), savedBy: parseStableId<"user">(row.saved_by) }));
    requireCondition(workbook.snapshot.analysisId === analysisId && workbook.snapshot.projectId === row.project_id, "Invalid stored workbook.");
    requireCondition(ANALYSIS_STATUSES.includes(row.analysis_status), "Invalid stored analysis status.");
    return { workbook, mutationId: parseStableId<"mutation">(row.mutation_id), signature: row.request_signature,
      analysisMetadata: { id: analysisId, name: row.analysis_name, status: row.analysis_status, version: workbook.version } };
  }

  async current(analysisId: unknown): Promise<SavedWorkbook | null> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(async tx => (await this.#current(tx, id))?.workbook ?? null);
  }
  async currentWithMetadata(analysisId: unknown): Promise<LoadedWorkbook | null> {
    const id = parseStableId<"analysis">(analysisId);
    return this.transaction(async tx => {
      const current = await this.#current(tx, id);
      return current ? freeze({ ...current.workbook, analysisMetadata: current.analysisMetadata }) : null;
    });
  }
  async listProjects() {
    return this.transaction(async tx => freeze([...(await this.#timed("db_query", () => tx<{ id: string; name: string }[]>`select id, name from procurement.projects order by id`))]));
  }
  async listAnalyses(projectId: unknown, options: AnalysisListQuery = {}): Promise<AnalysisPage> {
    const id = parseStableId<"project">(projectId);
    const q = parseAnalysisList(options);
    return this.transaction(async tx => {
      const [result] = await this.#timed("db_query", () => tx<{ items: AnalysisListItem[]; total: number; periods: string[]; has_before: boolean; has_after: boolean }[]>`
        with scoped as materialized (
          select a.id, a.name, a.project_id, a.status, c.version,
            case when c.analysis_date is null then null else
              'P' || case when extract(day from c.analysis_date) <= 14 then '1' else '2' end || '-' ||
              (array['JAN','FEB','MAR','APR','MEI','JUN','JUL','AGU','SEP','OKT','NOV','DES'])[extract(month from c.analysis_date)::int] || '-' ||
              lpad(extract(year from c.analysis_date)::text,4,'0') end as period
          from procurement.analyses a
          join procurement.current_workbooks c on c.analysis_id = a.id and c.owner_id = a.owner_id
          join procurement.projects p on p.id = a.project_id and p.owner_id = a.owner_id
          where a.project_id = ${id}
        ), filtered as materialized (
          select * from scoped where position(lower(${q.query}) in lower(name)) > 0
            and (${q.status} = '' or status = ${q.status})
            and (${q.period} = '' or (${q.period} = 'NONE' and period is null) or period = ${q.period})
            and (${q.analysisId}::uuid is null or id = ${q.analysisId})
        ), page as materialized (
          select * from filtered where (${q.after}::uuid is null or id > ${q.after})
            and (${q.before}::uuid is null or id < ${q.before})
          order by ${q.before ? tx`id desc` : tx`id asc`} limit ${q.limit}
        ) select coalesce((select jsonb_agg(page order by id) from page), '[]'::jsonb) as items,
          (select count(*)::int from filtered) as total,
          array(select distinct period from scoped where period is not null order by period) as periods,
          exists(select 1 from filtered where id < (select id from page order by id limit 1)) as has_before,
          exists(select 1 from filtered where id > (select id from page order by id desc limit 1)) as has_after`);
      const items = result!.items.map(item => ({ ...item, version: parseStableId<"version">(item.version) }));
      return freeze({ items, total: result!.total, periods: result!.periods,
        previousCursor: result!.has_before ? items[0]!.id : null,
        nextCursor: result!.has_after ? items.at(-1)!.id : null });
    }).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "42703") throw new WorkbookUpgradeRequiredError();
      throw error;
    });
  }

  async updateAnalysis(value: unknown, actorId: unknown, name: unknown, status: unknown, expected: unknown, mutation: unknown): Promise<AnalysisUpdateOutcome> {
    const analysisId = parseStableId<"analysis">(value);
    const actor = parseStableId<"user">(actorId);
    requireCondition(actor === this.actorId, "Resource unavailable or access denied.");
    requireCondition(typeof name === "string" && name.trim().length > 0, "Nama analisis wajib diisi.");
    requireCondition(typeof status === "string" && ANALYSIS_STATUSES.includes(status as AnalysisStatus), "Status analisis tidak valid.");
    const expectedVersion = parseStableId<"version">(expected), mutationId = parseStableId<"mutation">(mutation);
    const signature = createHash("sha256").update(canonicalJson({ operation: "UPDATE_ANALYSIS", analysisId, actor, name, status, expectedVersion, mutationId })).digest("hex");
    return this.transaction(async tx => {
      const [analysis] = await tx<{ project_id: string }[]>`select project_id from procurement.analyses where id = ${analysisId}`;
      if (!analysis) throw new AccessDeniedError();
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'project:' + analysis.project_id}, 0))`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + analysisId}, 0))`;
      const [current] = await tx<{ version: string; mutation_id: string; request_signature: string; name: string; status: AnalysisStatus }[]>`
        select c.version, c.mutation_id, c.request_signature, a.name, a.status from procurement.current_workbooks c
        join procurement.analyses a on a.id = c.analysis_id and a.owner_id = c.owner_id where c.analysis_id = ${analysisId}`;
      if (!current) throw new AccessDeniedError();
      if (current.mutation_id === mutationId) {
        if (current.request_signature !== signature) return { status: "REJECTED", code: "IDEMPOTENCY_CONFLICT", reason: "Mutation ID already used with another request." };
        return { id: analysisId, name: current.name, status: current.status, version: parseStableId<"version">(current.version) };
      }
      if (current.version !== expectedVersion) return { status: "CONFLICT", code: "STALE_VERSION", expectedVersion, currentVersion: parseStableId<"version">(current.version) };
      const version = createStableId<"version">();
      const [updated] = await tx<{ id: string; name: string; status: AnalysisStatus }[]>`
        update procurement.analyses set name = ${name.trim()}, status = ${status}
        where id = ${analysisId} returning id, name, status`;
      if (!updated) throw new AccessDeniedError();
      await tx`update procurement.current_workbooks set version = ${version}, mutation_id = ${mutationId}, request_signature = ${signature}
        where analysis_id = ${analysisId}`;
      return { ...updated, version };
    });
  }

  async deleteAnalysis(value: unknown, actorId: unknown) {
    const analysisId = parseStableId<"analysis">(value);
    const actor = parseStableId<"user">(actorId);
    if (actor !== this.actorId) throw new AccessDeniedError();
    return this.transaction(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + analysisId}, 0))`;
      await tx`delete from procurement.current_workbooks where analysis_id = ${analysisId}`;
      const [deleted] = await tx<{ id: string }[]>`delete from procurement.analyses where id = ${analysisId} returning id`;
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
      await tx`delete from procurement.current_workbooks where project_id = ${projectId}`;
      await tx`delete from procurement.analyses where project_id = ${projectId}`;
      const [deleted] = await tx<{ id: string }[]>`delete from procurement.projects where id = ${projectId} returning id`;
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
        await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'project:' + s.projectId}, 0))`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + s.analysisId}, 0))`;
        const prior = await this.#current(tx, s.analysisId);
        const next = planSave(request, actor, signature, prior);
        if (!("record" in next) || next.record === prior) return next.outcome;
        if (prior && next.record.workbook === prior.workbook) {
          await tx`update procurement.current_workbooks set mutation_id = ${request.mutationId}, request_signature = ${signature} where analysis_id = ${s.analysisId}`;
          return next.outcome;
        }
        if (!prior) {
          await tx`insert into procurement.projects (id, owner_id, name) values (${s.projectId}, ${SHARED_WORKSPACE_OWNER_ID}, ${s.project.name}) on conflict (id) do nothing`;
          const [project] = await tx`select id, name from procurement.projects where id = ${s.projectId}`;
          if (!project) throw new AccessDeniedError();
          requireCondition(project.name === s.project.name, "Project name differs from its stored metadata.");
          await tx`insert into procurement.analyses (id, project_id, owner_id, name)
            values (${s.analysisId}, ${s.projectId}, ${SHARED_WORKSPACE_OWNER_ID}, ${s.analysis.analysis.name}) on conflict (id) do nothing`;
          const [analysis] = await tx`select project_id from procurement.analyses where id = ${s.analysisId}`;
          if (!analysis) throw new AccessDeniedError();
          requireCondition(analysis.project_id === s.projectId, "An analysis cannot move to another project.");
        }
        const w = next.record.workbook;
        const encodeStarted = performance.now();
        const data = tx.json(JSON.parse(canonicalJson(encodeWorkbook(w.snapshot, w.configuration))));
        this.timings.encode = performance.now() - encodeStarted;
        await this.#timed("db_write", () => tx`insert into procurement.current_workbooks
          (analysis_id, project_id, owner_id, data, version, saved_at, saved_by, mutation_id, request_signature)
          values (${s.analysisId}, ${s.projectId}, ${SHARED_WORKSPACE_OWNER_ID}, ${data}, ${w.version}, ${w.savedAt}, ${actor}, ${request.mutationId}, ${signature})
          on conflict (analysis_id) do update set data = excluded.data,
            version = excluded.version, saved_at = excluded.saved_at, saved_by = excluded.saved_by,
            mutation_id = excluded.mutation_id, request_signature = excluded.request_signature`);
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
