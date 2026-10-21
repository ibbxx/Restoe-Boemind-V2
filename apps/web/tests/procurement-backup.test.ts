import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackup, verifyBackup, writeBackup } from "../scripts/procurement-backup.ts";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { prepareVendorColumns } from "../src/domain/dynamic-workflow.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { encodeWorkbook } from "../src/persistence/workbook-data.ts";

test("portable backup restores exact typed data, schema and RLS; corrupt archives fail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "procurement-backup-test-"));
  const file = join(directory, "backup.json.gz");
  try {
    const s = currentSnapshot(prepareVendorColumns(createProcurementWorkbook("Backup", "Restore")));
    const owner = id<"user">();
    const ledger = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).map(f => ({
      version: f.split("_")[0]!, name: f.replace(/^\d+_|\.sql$/g, ""),
    }));
    const data = {
      project: "local-fixture", exportedAt: "2026-10-20T11:00:00Z", ledger,
      projects: [{ id: s.projectId, owner_id: owner, name: s.project.name }],
      analyses: [{ id: s.analysisId, project_id: s.projectId, owner_id: owner, name: s.analysis.analysis.name, status: "HOLD" }],
      current_workbooks: [{ analysis_id: s.analysisId, project_id: s.projectId, owner_id: owner,
        data: encodeWorkbook(s, s.workbook!.configuration), version: id<"version">(), saved_by: owner,
        saved_at: "2026-10-20T11:00:00.123456+00:00", mutation_id: id<"mutation">(), request_signature: "a".repeat(64), analysis_date: null }],
    };
    const written = writeBackup(data, file);
    assert.equal(written.counts.workbooks, 1); assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readBackup(file).data, data);
    assert.throws(() => writeBackup(data, file), /EEXIST/);
    assert.equal((await verifyBackup(file)).verified, true);
    const bytes = readFileSync(file); bytes[10] = bytes[10]! ^ 1;
    writeFileSync(file, bytes);
    assert.throws(() => readBackup(file), /Archive checksum mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
