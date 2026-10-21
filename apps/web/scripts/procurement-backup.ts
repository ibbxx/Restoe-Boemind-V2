import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import postgres from "postgres";
import { canonicalJson } from "../src/domain/snapshots.ts";
import { decodeWorkbook } from "../src/persistence/workbook-data.ts";

type Row = Record<string, unknown>;
export interface ExportedData {
  project: string;
  exportedAt: string;
  projects: Row[];
  analyses: Row[];
  current_workbooks: Row[];
  ledger: { version: string; name: string }[];
}
interface Backup {
  format: "procurement-backup-v1";
  data: ExportedData;
  dataSha256: string;
  migrations: { name: string; sql: string; sha256: string }[];
}
export const exportQuery = `select jsonb_build_object(
  'project', current_database(), 'exportedAt', statement_timestamp(),
  'projects', coalesce((select jsonb_agg(p order by id) from procurement.projects p),'[]'),
  'analyses', coalesce((select jsonb_agg(a order by id) from procurement.analyses a),'[]'),
  'current_workbooks', coalesce((select jsonb_agg(c order by analysis_id) from procurement.current_workbooks c),'[]'),
  'ledger', coalesce((select jsonb_agg(jsonb_build_object('version',version,'name',name) order by version)
    from supabase_migrations.schema_migrations),'[]')) as backup`;
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
// shortcut: archives use memory up to 256 MiB decoded; use pg_dump for larger datasets.
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export function writeBackup(data: ExportedData, destination: string) {
  assert(data && Array.isArray(data.ledger), "Invalid backup export.");
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const versions = new Set(data.ledger.map(m => m.version));
  const migrations = readdirSync(directory).filter(name => versions.has(name.split("_")[0]!)).sort().map(name => {
    const sql = readFileSync(new URL(name, directory), "utf8");
    return { name, sql, sha256: hash(sql) };
  });
  assert.equal(migrations.length, versions.size, "Every cloud migration must have a local source.");
  const backup: Backup = { format: "procurement-backup-v1", data, dataSha256: hash(canonicalJson(data)), migrations };
  const serialized = JSON.stringify(backup);
  assert(Buffer.byteLength(serialized) <= MAX_BACKUP_BYTES, "Use pg_dump for backups larger than 256 MiB decoded.");
  const bytes = gzipSync(serialized);
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(destination + ".sha256", hash(bytes) + "\n", { flag: "wx", mode: 0o600 });
  return { bytes: bytes.length, sha256: hash(bytes), counts: {
    projects: data.projects.length, analyses: data.analyses.length, workbooks: data.current_workbooks.length } };
}

export function readBackup(file: string): Backup {
  const bytes = readFileSync(file);
  assert.equal(hash(bytes), readFileSync(file + ".sha256", "utf8").trim(), "Archive checksum mismatch.");
  const backup = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_BACKUP_BYTES }).toString()) as Backup;
  assert.equal(backup.format, "procurement-backup-v1");
  assert.equal(hash(canonicalJson(backup.data)), backup.dataSha256, "Data checksum mismatch.");
  for (const migration of backup.migrations) assert.equal(hash(migration.sql), migration.sha256, "Migration checksum mismatch.");
  for (const table of ["projects", "analyses", "current_workbooks"] as const) assert(Array.isArray(backup.data[table]));
  return backup;
}

// Restore verification always creates its own temporary loopback cluster; it accepts no target URL.
export async function verifyBackup(file: string) {
  const backup = readBackup(file);
  const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
  const command = (name: string, args: string[]) => {
    const result = spawnSync(join(bin, name), args, { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const directory = mkdtempSync(join(tmpdir(), "procurement-backup-verify-"));
  let started = false, sql: postgres.Sql | undefined;
  try {
    command("initdb", ["-D", join(directory, "db"), "-A", "trust", "-U", "postgres", "--no-locale"]);
    command("pg_ctl", ["-D", join(directory, "db"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
    started = true;
    sql = postgres({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 1, onnotice: () => {} });
    await sql.unsafe(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';`);
    for (const migration of backup.migrations) await sql.begin(tx => tx.unsafe(migration.sql));
    await sql.begin(async tx => {
      for (const table of ["projects", "analyses", "current_workbooks"] as const) {
        const rows = backup.data[table];
        if (!rows.length) continue;
        const columns = await tx<{ column_name: string; is_generated: string }[]>`select column_name, is_generated from information_schema.columns
          where table_schema='procurement' and table_name=${table} order by ordinal_position`;
        for (const row of rows) assert.equal(hash(canonicalJson(Object.keys(row).sort())),
          hash(canonicalJson(columns.map(c => c.column_name).sort())), "Backup columns differ: " + table);
        const names = columns.filter(c => c.is_generated === 'NEVER').map(c => c.column_name);
        await tx`insert into procurement.${tx(table)} (${tx(names)}) select ${tx(names)}
          from jsonb_populate_recordset(null::procurement.${tx(table)}, ${tx.json(rows as postgres.JSONValue[])}::jsonb)`;
        const restored = await tx`select to_jsonb(t) as row from procurement.${tx(table)} t order by ${tx(table === "current_workbooks" ? "analysis_id" : "id")}`;
        const expected = await tx`select to_jsonb(t) as row from jsonb_populate_recordset(null::procurement.${tx(table)}, ${tx.json(rows as postgres.JSONValue[])}::jsonb) t
          order by ${tx(table === "current_workbooks" ? "analysis_id" : "id")}`;
        assert.equal(hash(canonicalJson(restored.map(r => r.row))), hash(canonicalJson(expected.map(r => r.row))), "Restored rows differ: " + table);
      }
    });
    for (const row of backup.data.current_workbooks) {
      const analysis = backup.data.analyses.find(a => a.id === row.analysis_id)!;
      const project = backup.data.projects.find(p => p.id === row.project_id)!;
      decodeWorkbook(row.data, { analysisId: String(row.analysis_id), projectId: String(row.project_id), analysisName: String(analysis.name), projectName: String(project.name) });
    }
    const tables = await sql`select tablename from pg_tables where schemaname='procurement' order by tablename`;
    assert.deepEqual(tables.map(t => t.tablename), ["analyses", "current_workbooks", "projects"]);
    const [policies] = await sql`select count(*)::int as count from pg_policies where schemaname='procurement'`;
    assert.equal(policies!.count, 12);
    const security = await sql`select relrowsecurity and relforcerowsecurity as protected from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='procurement' and c.relkind='r'`;
    assert(security.every(row => row.protected));
    return { verified: true, dataSha256: backup.dataSha256, workbooks: backup.data.current_workbooks.length };
  } finally {
    await sql?.end({ timeout: 3 });
    if (started) command("pg_ctl", ["-D", join(directory, "db"), "-m", "fast", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, file, output] = process.argv.slice(2);
    assert(file, "Usage: procurement-backup.ts export <archive.gz> | pack <export.json> <archive.gz> | verify <archive.gz>");
    if (operation === "verify") console.log(JSON.stringify(await verifyBackup(file)));
    else if (operation === "pack") {
      assert(output, "Output archive required.");
      console.log(JSON.stringify(writeBackup(JSON.parse(readFileSync(file, "utf8")), output)));
    } else {
      assert.equal(operation, "export");
      assert(process.env.BACKUP_DATABASE_URL, "Set a separate operator BACKUP_DATABASE_URL; the application login cannot export all owners.");
      const sql = postgres(process.env.BACKUP_DATABASE_URL, { max: 1, prepare: false, ssl: "verify-full", onnotice: () => {} });
      try {
        const data = await sql.begin("isolation level repeatable read read only", async tx => {
          const [role] = await tx`select rolbypassrls from pg_roles where rolname=current_user`;
          assert.equal(role?.rolbypassrls, true, "An authorized backup operator is required.");
          const [row] = await tx.unsafe(exportQuery);
          return row!.backup as ExportedData;
        });
        console.log(JSON.stringify(writeBackup(data as ExportedData, file)));
      } finally { await sql.end({ timeout: 3 }); }
    }
  } catch {
    console.error("Backup failed validation or database access; no credentials or row data are logged.");
    process.exitCode = 1;
  }
}
