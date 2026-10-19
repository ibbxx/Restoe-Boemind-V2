// Operator-only backfill, never imported by the application or executed on startup.
import postgres from "postgres";
import { createHash } from "node:crypto";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { legacyConfiguration } from "../src/domain/legacy-sheet.ts";
import { prepareCalculationPolicy } from "../src/domain/calculation-policy.ts";
import { createStableId, parseStableId } from "../src/domain/ids.ts";
import { canonicalJson, captureSnapshot } from "../src/domain/snapshots.ts";
import { DomainValidationError, requireCondition } from "../src/domain/validation.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import type { EngineConfiguration } from "../src/engine/contracts.ts";
import { captureSavedWorkbook } from "../src/persistence/current-workbook.ts";

type Head = { analysis_id: string; project_id: string; owner_id: string; actor_id: string;
  snapshot: WorkbookSnapshot; saved_at: string; source_id: string };
type Configuration = { configuration: EngineConfiguration; snapshot_id: string; policy_version_id: string | null; cell_ids: string[] };

async function migrate() {
  const url = process.env.PROCUREMENT_MIGRATION_DATABASE_URL;
  requireCondition(url, "PROCUREMENT_MIGRATION_DATABASE_URL is required; the application login cannot migrate archives.");
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 10, ssl: "verify-full", onnotice: () => {} });
  try {
    const result = await sql.begin(async tx => {
      await tx`set local lock_timeout = '10s'`;
      await tx`set local statement_timeout = '60s'`;
      const [role] = await tx`select rolbypassrls or rolsuper as allowed from pg_roles where rolname = current_user`;
      requireCondition(role?.allowed === true, "Use an authorized operator connection, never the runtime login.");
      await tx`lock table procurement.projects, procurement.analyses, procurement.analysis_heads, procurement.revisions,
        procurement.calculation_runs, procurement.current_workbooks in share row exclusive mode`;
      const heads = await tx<Head[]>`select h.analysis_id, a.project_id, h.owner_id,
        r.payload->>'actorId' as actor_id, r.payload#>'{revision,snapshot}' as snapshot,
        r.payload#>>'{revision,savedAt}' as saved_at,
        coalesce(r.payload#>>'{revision,restoredFrom,snapshotId}', r.snapshot_id::text) as source_id
        from procurement.analysis_heads h join procurement.revisions r on r.analysis_id = h.analysis_id and r.id = h.revision_id
        join procurement.analyses a on a.id = h.analysis_id and a.owner_id = h.owner_id
        where not exists (select 1 from procurement.current_workbooks c where c.analysis_id = h.analysis_id)
        order by h.analysis_id`;
      for (const head of heads) {
        const original = captureSnapshot(head.snapshot);
        requireCondition(original.analysisId === head.analysis_id && original.projectId === head.project_id && head.actor_id === head.owner_id,
          "Legacy identity mismatch; no data was migrated.");
        let configuration = original.workbook?.configuration ?? null;
        if (!original.workbook) {
          const configurations = await tx<Configuration[]>`select payload#>'{manifest,configuration}' as configuration,
            snapshot_id, policy_version_id,
            jsonb_path_query_array(payload, '$.manifest.snapshot.worksheets[*].tables[*].cells[*].id') as cell_ids
            from procurement.calculation_runs where analysis_id = ${head.analysis_id} order by created_at, id`;
          const inventory = original.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))).sort().join(",");
          const matchingPolicy = configurations.filter(r => original.policy.status === "CONFIGURED" && r.policy_version_id === original.policy.versionId);
          const matching = matchingPolicy.findLast(r => r.snapshot_id === head.source_id)
            ?? matchingPolicy.findLast(r => [...r.cell_ids].sort().join(",") === inventory)
            ?? configurations.findLast(r => [...r.cell_ids].sort().join(",") === inventory);
          requireCondition(matching || configurations.length === 0, "Legacy configuration cannot be matched; migration stopped without guessing units.");
          configuration = legacyConfiguration(original, matching?.configuration ?? null);
        }
        const prepared = prepareCalculationPolicy(currentSnapshot(original), configuration);
        const workbook = captureSavedWorkbook({ snapshot: prepared.snapshot, configuration: prepared.configuration,
          version: createStableId<"version">(), savedAt: head.saved_at, savedBy: parseStableId<"user">(head.owner_id) });
        requireCondition(canonicalJson(original.worksheets) === canonicalJson(workbook.snapshot.worksheets)
          && canonicalJson(original.formulas) === canonicalJson(workbook.snapshot.formulas), "Migration changed worksheet data or formulas.");
        const signature = createHash("sha256").update(canonicalJson(workbook)).digest("hex");
        await tx`insert into procurement.current_workbooks
          (analysis_id, project_id, owner_id, snapshot, configuration, version, saved_at, saved_by, mutation_id, request_signature)
          values (${head.analysis_id}, ${head.project_id}, ${head.owner_id}, ${tx.json(JSON.parse(canonicalJson(workbook.snapshot)))},
            ${workbook.configuration === null ? null : tx.json(JSON.parse(canonicalJson(workbook.configuration)))},
            ${workbook.version}, ${workbook.savedAt}, ${workbook.savedBy}, ${createStableId<"mutation">()}, ${signature})
          on conflict (analysis_id) do nothing`;
      }
      const [missing] = await tx`select count(*)::int as count from procurement.analysis_heads h
        where not exists (select 1 from procurement.current_workbooks c where c.analysis_id = h.analysis_id and c.owner_id = h.owner_id)`;
      requireCondition(missing?.count === 0, "Not every saved analysis has a current workbook; migration rolled back.");
      return heads.length;
    });
    console.info(`Migrasi selesai: ${result} lembar dipindahkan. Data terbaru yang sudah ada tidak ditimpa; arsip lama tetap utuh.`);
  } finally { await sql.end({ timeout: 5 }); }
}

void migrate().catch(cause => {
  // Driver errors can include connection details; never print them or the operator URL.
  console.error("Migrasi belum terkonfirmasi. Jangan buka akses pengguna sebelum seluruh kondisi terbaru diperiksa.");
  if (cause instanceof DomainValidationError) console.error(cause.message);
  process.exitCode = 1;
});
