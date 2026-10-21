import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import postgres from "postgres";
import { createProcurementWorkbook } from "../src/domain/procurement-template.ts";
import { emptyWorkbook, changeWorkbook } from "../src/domain/workflow.ts";
import { prepareVendorColumns, selectSheetOffer, changeSheetProfile } from "../src/domain/dynamic-workflow.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../src/domain/legacy-sheet.ts";
import { ahsVolumeSource, connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { addAhsItem, ahsGroups, ahsCell, ahsRoleCell, ahsLabel, prepareAhsRollups } from "../src/domain/ahs-groups.ts";
import { addAhsField, ahsFields } from "../src/domain/ahs-fields.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { analysisPeriod } from "../src/domain/analysis-creation.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import type { SaveRequest } from "../src/application/contracts.ts";
import { prepareCalculationPolicy } from "../src/domain/calculation-policy.ts";
import { setCellFormula, setCellInput } from "../src/domain/structure.ts";
import { canvasCellAddresses } from "../src/domain/canvas-address.ts";
import { displayFormula, resolveFormula } from "../src/domain/cell-address.ts";
import { PostgresWorkbookRepository } from "../src/persistence/postgres-workbook-repository.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { createWorkbookHandler } from "../src/server/workbook-handler.ts";
import { AuthenticationError } from "../src/server/supabase-auth.ts";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = readdirSync(migrations).filter(f => f.endsWith(".sql")).sort();
const currentOnlyMigration = migrationFiles.find(file => file.includes("20261019071911_current_only_procurement"))!;
const sharedWorkspaceMigration = migrationFiles.find(file => file.includes("20261021073232_shared_workspace_data"))!;
const deleteAnalysisMigration = migrationFiles.find(file => file.includes("202610200001_allow_analysis_delete"))!;
const deleteProjectMigration = migrationFiles.find(file => file.includes("20261020042433_allow_project_delete"))!;
const listMetadataMigration = migrationFiles.find(file => file.includes("workbook_list_metadata"))!;
const actor = id<"user">(), other = id<"user">();

function legacyPayload(s: WorkbookSnapshot) {
  const revisionIds = new Map(s.analysis.offers.map(o => [o.id, id<"offer">()]));
  return { ...s, selectedOfferId: undefined, selectedOfferRevisionId: s.selectedOfferId ? revisionIds.get(s.selectedOfferId) : null,
    calculationRunRefs: [], analysis: { ...s.analysis,
      offers: s.analysis.offers.map(({ values, ...o }) => { void values; return o; }),
      offerRevisions: s.analysis.offers.map(o => ({ id: revisionIds.get(o.id), offerId: o.id, revisionNumber: 1, values: o.values })) },
    profiles: Object.fromEntries(Object.entries(s.profiles).map(([p, v]) => [p, { ...v, reviewContext: null, hppBase: { ...v.hppBase, contextRunId: null } }])),
    formulas: s.formulas.map(f => ({ ...f, versionId: id<"formula">() })),
    mappings: s.mappings.map(m => ({ ...m, versionId: id<"mapping">(), provenance: { ...m.provenance, changeEventId: id<"mapping">(), sourceRef: m.provenance.sourceRef ? revisionIds.get(m.provenance.sourceRef as typeof s.selectedOfferId & string) ?? m.provenance.sourceRef : null } })),
    ...(s.workbook ? { workbook: { ...s.workbook, offers: s.workbook.offers.map(o => ({ ...o, revisionId: revisionIds.get(o.offerId) })),
      selections: Object.fromEntries(Object.entries(s.workbook.selections).map(([p, selection]) => [p, selection ? revisionIds.get(selection) : null])) } } : {}) };
}

function numericCell(s: WorkbookSnapshot, cellId: string, value: string) {
  return changeWorkbook(s, { worksheets: s.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t,
    cells: t.cells.map(c => c.id === cellId ? { ...c, source: { kind: "INPUT" as const, input: { kind: "NUMERIC_TEXT" as const, text: value } } } : c) })) })) });
}

test("current-only migration, repeated Save, isolation and AHS round trips", async t => {
  const directory = mkdtempSync(join(tmpdir(), "procurement-current-only-"));
  const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
  function command(name: string, args: string[]) {
    const r = spawnSync(join(bin, name), args, { encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
  }
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  let started = false;
  let admin: postgres.Sql | undefined, login: postgres.Sql | undefined;
  const statements: string[] = [];
  try {
    command("initdb", ["-D", join(directory, "db"), "-A", "trust", "-U", "postgres", "--no-locale"]);
    command("pg_ctl", ["-D", join(directory, "db"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]); started = true;
    admin = postgres({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 1, onnotice: () => {} });
    await admin.unsafe(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';`);
    for (const file of migrationFiles.filter(file => file !== currentOnlyMigration && file !== sharedWorkspaceMigration && file !== deleteAnalysisMigration && file !== deleteProjectMigration && file !== listMetadataMigration)) {
      await admin.begin(tx => tx.unsafe(readFileSync(new URL(file, migrations), "utf8")));
    }

    let dynamic = currentSnapshot(prepareVendorColumns(createProcurementWorkbook("Project migration", "Dynamic")));
    dynamic = numericCell(dynamic, dynamic.workbook!.offers[0]!.baseCellId, "20000");
    dynamic = selectSheetOffer(dynamic, dynamic.analysis.offers[0]!.id, actor, "INU");
    dynamic = selectSheetOffer(dynamic, dynamic.analysis.offers[1]!.id, actor, "SOLAR_BAWAH");
    const pphCell = dynamic.workbook!.cells.find(c => c.address === "C13")!.cellId;
    dynamic = setCellFormula(dynamic, pphCell, `@{${dynamic.workbook!.offers[0]!.baseCellId}}*0.02`);
    const vendorNameCell = dynamic.workbook!.offers[0]!.nameCellId;
    dynamic = setCellFormula(dynamic, vendorNameCell, '"Vendor formula"');
    dynamic = currentSnapshot(dynamic);
    const legacyDraft = prepareLegacySheet(emptyWorkbook("Legacy", "Legacy"));
    const legacy = currentSnapshot(prepareCalculationPolicy(legacyDraft, legacyConfiguration(legacyDraft, null)).snapshot);
    const seeds = [dynamic, legacy];
    const configs = [dynamic.workbook!.configuration!, legacyConfiguration(legacy, null)];
    assert(configs.every(Boolean));
    const versions = seeds.map(() => id<"version">());
    for (const [i, s] of seeds.entries()) {
      await admin`insert into procurement.projects values (${s.projectId},${actor},${s.project.name})`;
      await admin`insert into procurement.analyses values (${s.analysisId},${s.projectId},${actor},${s.analysis.analysis.name})`;
      const raw = JSON.parse(JSON.stringify(legacyPayload(s)));
      await admin`insert into procurement.current_workbooks values (${s.analysisId},${s.projectId},${actor},${admin.json(raw)},${admin.json(JSON.parse(JSON.stringify(configs[i])))},${versions[i]!},now(),${actor},${id<"mutation">()},${"0".repeat(64)})`;
      await admin`insert into procurement.workbook_snapshots (id,analysis_id,owner_id,payload) values (${s.id},${s.analysisId},${actor},${admin.json(raw)})`;
      const archivedId = id<"version">();
      const envelope = { projectId: s.projectId, analysisId: s.analysisId, actorId: actor, mutationId: id<"mutation">(), changeEvent: {},
        revision: { kind: "SAVED_DRAFT", revisionId: archivedId, snapshot: raw, run: null, parentRevisionId: null, savedAt: new Date().toISOString(), restoredFrom: null } };
      await admin`insert into procurement.revisions (id,analysis_id,owner_id,snapshot_id,ordinal,payload)
        values (${archivedId},${s.analysisId},${actor},${s.id},1,${admin.json(envelope)})`;
      await admin`insert into procurement.analysis_heads values (${s.analysisId},${actor},${archivedId})`;
    }

    await t.test("migration refuses missing current data and rolls back without deleting archives", async () => {
      await assert.rejects(admin!.begin(async tx => {
        await tx`insert into procurement.analyses values (${id<"analysis">()},${dynamic.projectId},${actor},'Missing current')`;
        await tx.unsafe(readFileSync(new URL(currentOnlyMigration, migrations), "utf8"));
      }), /Every existing Analysis must have current data/);
      const [old] = await admin!`select to_regclass('procurement.revisions') is not null as present`;
      assert.equal(old!.present, true);
    });
    await t.test("migration retains active inputs, formulas, IDs and numerical results", async () => {
      await admin!.begin(tx => tx.unsafe(readFileSync(new URL(currentOnlyMigration, migrations), "utf8")));
      for (const [i, s] of seeds.entries()) {
        const [row] = await admin!`select data from procurement.current_workbooks where analysis_id=${s.analysisId}`;
        const decoded = decodeWorkbook(row!.data, { analysisId: s.analysisId, projectId: s.projectId, analysisName: s.analysis.analysis.name, projectName: s.project.name });
        assert.equal(canonicalJson(decoded.snapshot), canonicalJson(s));
        for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
          const before = new FormulaEngine(configs[i]!).evaluate({ ...s, activeProfile: profile, selectedOfferId: s.workbook?.selections[profile] ?? s.selectedOfferId });
          const after = new FormulaEngine(decoded.configuration!).evaluate({ ...decoded.snapshot, activeProfile: profile, selectedOfferId: decoded.snapshot.workbook?.selections[profile] ?? decoded.snapshot.selectedOfferId });
          assert.deepEqual(after.results, before.results); assert.deepEqual(after.provisional, before.provisional);
        }
      }
    });
    await t.test("exactly three tables, nine owner policies, no history triggers or RPCs", async () => {
      const tables = await admin!`select tablename from pg_tables where schemaname='procurement' order by tablename`;
      assert.deepEqual(tables.map(r => r.tablename), ["analyses", "current_workbooks", "projects"]);
      const [policies] = await admin!`select count(*)::int as count from pg_policies where schemaname='procurement'`;
      assert.equal(policies!.count, 9);
      const triggers = await admin!`select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='procurement' and not t.tgisinternal`;
      assert.equal(triggers.length, 0);
      const functions = await admin!`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='procurement'`;
      assert.deepEqual(functions.map(f => f.proname), ["current_actor_id"]);
    });
    await admin!.begin(tx => tx.unsafe(readFileSync(new URL(deleteAnalysisMigration, migrations), "utf8")));
    await admin!.begin(tx => tx.unsafe(readFileSync(new URL(deleteProjectMigration, migrations), "utf8")));
    const beforeProjection = await admin`select analysis_id, data::text as data, version, saved_at, mutation_id, request_signature from procurement.current_workbooks order by analysis_id`;
    await admin!.begin(tx => tx.unsafe(readFileSync(new URL(listMetadataMigration, migrations), "utf8")));
    assert.deepEqual(await admin`select analysis_id, data::text as data, version, saved_at, mutation_id, request_signature from procurement.current_workbooks order by analysis_id`, beforeProjection);
    await admin!.begin(tx => tx.unsafe(readFileSync(new URL(sharedWorkspaceMigration, migrations), "utf8")));
    await admin.unsafe("create role procurement_app_test login noinherit; grant procurement_runtime to procurement_app_test;");
    login = postgres({ host: "127.0.0.1", port, user: "procurement_app_test", database: "postgres", max: 2, onnotice: () => {}, debug: (_connection, query) => { statements.push(query); } });
    const repo = new PostgresWorkbookRepository(login, actor);
    const repoOther = new PostgresWorkbookRepository(login, other);

    await t.test("ten Saves update one row; retry, stale and mismatched retry are guarded", async () => {
      let saved = await repo.current(dynamic.analysisId); assert(saved);
      const originalVersion = saved.version;
      for (let i = 0; i < 10; i++) {
        const s = numericCell(saved.snapshot, dynamic.workbook!.offers[0]!.baseCellId, String(21000 + i));
        const request: SaveRequest = { snapshot: s, configuration: s.workbook!.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() };
        const result = await repo.save(request, actor); assert.equal(result.status, "SAVED");
        if (result.status !== "SAVED") throw new Error("Save rejected");
        saved = result.workbook;
        assert.deepEqual(await repo.save(request, actor), result);
        assert.equal((await repo.save({ ...request, snapshot: numericCell(s, dynamic.workbook!.offers[0]!.baseCellId, "9") }, actor)).status, "REJECTED");
        const [count] = await admin!`select count(*)::int as count from procurement.current_workbooks where analysis_id=${dynamic.analysisId}`;
        assert.equal(count!.count, 1);
      }
      const stale = await repo.save({ snapshot: saved.snapshot, configuration: saved.configuration, expectedVersion: originalVersion, mutationId: id<"mutation">() }, actor);
      assert.equal(stale.status, "CONFLICT");
      const reloaded = await new PostgresWorkbookRepository(login!, actor).current(dynamic.analysisId); assert(reloaded);
      const cell = reloaded.snapshot.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === dynamic.workbook!.offers[0]!.baseCellId)!;
      assert.deepEqual(cell.source, { kind: "INPUT", input: { kind: "NUMERIC_TEXT", text: "21009" } });
      assert.equal(canonicalJson(reloaded.snapshot), canonicalJson(saved.snapshot));
    });
    await t.test("one Project supports multiple independent Analysis rows", async () => {
      const s = currentSnapshot(prepareVendorColumns(createProcurementWorkbook(dynamic.project.name, "Second", dynamic.projectId)));
      const outcome = await repo.save({ snapshot: s, configuration: s.workbook!.configuration, expectedVersion: null, mutationId: id<"mutation">() }, actor);
      assert.equal(outcome.status, "SAVED"); assert.equal((await repo.listAnalyses(dynamic.projectId)).items.length, 2);
      assert(outcome.status === "SAVED");
      const updated = await repo.updateAnalysis(s.analysisId, actor, "Second renamed", "HOLD", outcome.workbook.version, id<"mutation">());
      assert(!("code" in updated));
      assert.deepEqual(updated, { id: s.analysisId, name: "Second renamed", status: "HOLD", version: updated.version });
      const listed = (await repo.listAnalyses(dynamic.projectId)).items;
      assert.deepEqual(listed.find(item => item.id === s.analysisId), { id: s.analysisId, name: "Second renamed", project_id: dynamic.projectId, status: "HOLD", version: updated.version, period: null });
      assert.equal((await repo.current(dynamic.analysisId))!.snapshot.analysis.analysis.name, "Dynamic");
    });
    await t.test("unchanged Saves and edit-revert retain JSON, version and saved time in both formats", async () => {
      for (const s of seeds) {
        const saved = await repo.current(s.analysisId); assert(saved);
        const [before] = await admin!`select data::text as data, version, saved_at, data as payload from procurement.current_workbooks where analysis_id=${s.analysisId}`;
        for (let i = 0; i < 3; i++) {
          const draft = changeWorkbook(saved.snapshot, {});
          const request: SaveRequest = { snapshot: draft, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() };
          const outcome = await repo.save(request, actor);
          assert.deepEqual(outcome, { status: "SAVED", workbook: saved });
          assert.deepEqual(await repo.save(request, actor), outcome);
          const [after] = await admin!`select data::text as data, version, saved_at, mutation_id from procurement.current_workbooks where analysis_id=${s.analysisId}`;
          assert.equal(after!.data, before!.data); assert.equal(after!.version, before!.version);
          assert.deepEqual(after!.saved_at, before!.saved_at); assert.equal(after!.mutation_id, request.mutationId);
        }
        const cells = saved.snapshot.worksheets.flatMap(w => w.tables.flatMap(t => t.cells));
        const cell = cells.find(c => c.source.kind === "INPUT" && c.source.input.kind === "NUMERIC_TEXT"); assert(cell);
        let reverted = numericCell(saved.snapshot, cell.id, "123456");
        reverted = changeWorkbook(reverted, { worksheets: saved.snapshot.worksheets });
        assert.deepEqual(await repo.save({ snapshot: reverted, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor), { status: "SAVED", workbook: saved });
      }
    });
    await t.test("metadata is versioned, retries are safe, stale Save cannot undo rename and JSON is untouched", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const [before] = await admin!`select data::text as data, saved_at from procurement.current_workbooks where analysis_id=${dynamic.analysisId}`;
      const mutationId = id<"mutation">();
      const updated = await repo.updateAnalysis(dynamic.analysisId, actor, "Dynamic renamed", "HOLD", saved.version, mutationId);
      assert(!("code" in updated)); assert.notEqual(updated.version, saved.version);
      assert.deepEqual(await repo.updateAnalysis(dynamic.analysisId, actor, "Dynamic renamed", "HOLD", saved.version, mutationId), updated);
      const mismatch = await repo.updateAnalysis(dynamic.analysisId, actor, "Other name", "HOLD", saved.version, mutationId);
      assert("code" in mismatch && mismatch.code === "IDEMPOTENCY_CONFLICT");
      const stale = await repo.updateAnalysis(dynamic.analysisId, actor, "Old name", "DRAFT", saved.version, id<"mutation">());
      assert("code" in stale && stale.code === "STALE_VERSION");
      const oldSave = await repo.save({ snapshot: saved.snapshot, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
      assert.equal(oldSave.status, "CONFLICT");
      const [after] = await admin!`select data::text as data, saved_at from procurement.current_workbooks where analysis_id=${dynamic.analysisId}`;
      assert.deepEqual(after, before);
      const renamed = await repo.current(dynamic.analysisId); assert(renamed);
      assert.equal(renamed.snapshot.analysis.analysis.name, "Dynamic renamed");
      const illegalRename = await repo.save({ snapshot: saved.snapshot, configuration: saved.configuration, expectedVersion: updated.version, mutationId: id<"mutation">() }, actor);
      assert.equal(illegalRename.status, "REJECTED");
      const results = await Promise.all(["DRAFT", "HOLD"].map(status => repo.updateAnalysis(dynamic.analysisId, actor, "Dynamic renamed", status, updated.version, id<"mutation">())));
      assert.equal(results.filter(result => !("code" in result)).length, 1);
      assert.equal(results.filter(result => "code" in result && result.code === "STALE_VERSION").length, 1);
      const staleOther = await repoOther.updateAnalysis(dynamic.analysisId, other, "Dynamic renamed", "HOLD", updated.version, id<"mutation">());
      assert("code" in staleOther && staleOther.code === "STALE_VERSION");
      const shared = await repoOther.current(dynamic.analysisId); assert(shared);
      const sharedUpdate = await repoOther.updateAnalysis(dynamic.analysisId, other, "Dynamic renamed", "HOLD", shared.version, id<"mutation">());
      assert(!("code" in sharedUpdate));
      assert.equal((await repo.current(dynamic.analysisId))!.version, sharedUpdate.version);
    });
    await t.test("simultaneous Saves accept one writer and preserve the latest committed data", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const results = await Promise.all([{ repository: repo, user: actor }, { repository: repoOther, user: other }].map(({ repository, user }, n) => repository.save({ snapshot: numericCell(saved.snapshot, dynamic.workbook!.offers[0]!.baseCellId, String(22001+n)),
        configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, user)));
      assert.equal(results.filter(r => r.status === "SAVED").length, 1);
      assert.equal(results.filter(r => r.status === "CONFLICT").length, 1);
      const winner = results.find(r => r.status === "SAVED"); assert(winner?.status === "SAVED");
      assert.deepEqual(await repo.current(dynamic.analysisId), winner.workbook);
    });
    await t.test("metadata and Save racing on the same version accept exactly one writer", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const [metadata, save] = await Promise.all([
        repo.updateAnalysis(dynamic.analysisId, actor, saved.snapshot.analysis.analysis.name, "DRAFT", saved.version, id<"mutation">()),
        repo.save({ snapshot: numericCell(saved.snapshot, dynamic.workbook!.offers[0]!.baseCellId, "23000"), configuration: saved.configuration,
          expectedVersion: saved.version, mutationId: id<"mutation">() }, actor),
      ]);
      assert.equal(Number(!("code" in metadata)) + Number(save.status === "SAVED"), 1);
      assert.equal(Number("code" in metadata && metadata.code === "STALE_VERSION") + Number(save.status === "CONFLICT"), 1);
    });
    await t.test("configuration-only changes are real Saves, then become no-ops", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved?.configuration && saved.snapshot.workbook);
      const configuration = { ...saved.configuration, version: saved.configuration.version + "-storage-test" };
      const snapshot = changeWorkbook(saved.snapshot, { workbook: { ...saved.snapshot.workbook, configuration } });
      const result = await repo.save({ snapshot, configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
      assert(result.status === "SAVED"); assert.notEqual(result.workbook.version, saved.version);
      assert.deepEqual((await repo.current(dynamic.analysisId))!.configuration, configuration);
      assert.deepEqual(await repo.save({ snapshot: changeWorkbook(snapshot, {}), configuration, expectedVersion: result.workbook.version, mutationId: id<"mutation">() }, actor), result);
      assert.equal((await repo.save({ snapshot: saved.snapshot, configuration: saved.configuration, expectedVersion: result.workbook.version, mutationId: id<"mutation">() }, actor)).status, "SAVED");
    });
    await t.test("metadata-only list preserves the original period lookup for legacy and dynamic workbooks", async () => {
      for (const seed of seeds) {
        let saved = await repo.current(seed.analysisId); assert(saved);
        const original = saved;
        const dates = saved.snapshot.worksheets.find(w => w.stage === "AHS")!.tables.flatMap(t => t.cells.filter(cell =>
          t.rows.find(r => r.id === cell.rowId)?.label === "Tgl Analisis (Rn)" ||
          saved!.snapshot.workbook?.cells.find(p => p.cellId === cell.id)?.address === (cell.scope === "INU" ? "H4" : "H3")));
        assert(dates.length >= 2);
        for (const value of ["14/10/2026", "15/10/2026", "31/02/2026", "29/02/2024", "29/02/2023", "01/01/0000", ""]) {
          for (const activeProfile of ["INU", "SOLAR_BAWAH"] as const) {
            const snapshot = changeWorkbook(saved.snapshot, { activeProfile, selectedOfferId: saved.snapshot.workbook?.selections[activeProfile] ?? saved.snapshot.selectedOfferId,
              worksheets: saved.snapshot.worksheets.map(w => ({ ...w, tables: w.tables.map(t => ({ ...t, cells: t.cells.map(c =>
                dates.some(d => d.id === c.id) ? { ...c, source: { kind: "INPUT" as const, input: { kind: "TEXT" as const, text: c.id === dates[0]!.id ? value : "01/11/2026" } } } : c) })) })) });
            const outcome = await repo.save({ snapshot, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
            assert(outcome.status === "SAVED"); saved = outcome.workbook;
            const listed = (await repo.listAnalyses(seed.projectId)).items.find(a => a.id === seed.analysisId)!;
            const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
            assert.equal(listed.period, (match ? analysisPeriod(`${match[3]}-${match[2]}-${match[1]}`) : "") || null);
            assert.equal(listed.version, saved.version);
            assert.deepEqual(Object.keys(listed).sort(), ["id", "name", "period", "project_id", "status", "version"]);
          }
        }
        const formula = setCellFormula(saved.snapshot, dates[0]!.id, '"20/10/2026"');
        const outcome = await repo.save({ snapshot: formula, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
        assert(outcome.status === "SAVED");
        assert.equal((await repo.listAnalyses(seed.projectId)).items.find(a => a.id === seed.analysisId)!.period, null);
        assert.equal((await repo.save({ snapshot: original.snapshot, configuration: original.configuration, expectedVersion: outcome.workbook.version, mutationId: id<"mutation">() }, actor)).status, "SAVED");
      }
    });
    await t.test("keyset pages, backward navigation, filters and RLS use only metadata", async () => {
      for (let i = 0; i < 6; i++) {
        const s = currentSnapshot(prepareVendorColumns(createProcurementWorkbook(dynamic.project.name, i === 5 ? "Paged 100%_" : "Paged " + i, dynamic.projectId)));
        const saved = await repo.save({ snapshot: s, configuration: s.workbook!.configuration, expectedVersion: null, mutationId: id<"mutation">() }, actor);
        assert(saved.status === "SAVED");
        if (i % 2) await repo.updateAnalysis(s.analysisId, actor, s.analysis.analysis.name, "HOLD", saved.workbook.version, id<"mutation">());
      }
      const options = { limit: 2, query: " pAgEd " };
      const first = await repo.listAnalyses(dynamic.projectId, options);
      assert.equal(first.items.length, 2); assert.equal(first.total, 6);
      assert.equal(first.previousCursor, null); assert(first.nextCursor);
      const second = await repo.listAnalyses(dynamic.projectId, { ...options, after: first.nextCursor });
      assert(second.previousCursor && second.nextCursor);
      assert.deepEqual((await repo.listAnalyses(dynamic.projectId, { ...options, before: second.previousCursor })).items, first.items);
      const third = await repo.listAnalyses(dynamic.projectId, { ...options, after: second.nextCursor });
      assert.equal(third.nextCursor, null);
      assert.equal(new Set([...first.items, ...second.items, ...third.items].map(a => a.id)).size, 6);
      assert.equal((await repo.listAnalyses(dynamic.projectId, { query: "100%_" })).total, 1);
      assert.equal((await repo.listAnalyses(dynamic.projectId, { query: "Paged", status: "HOLD" })).total, 3);
      assert.equal((await repo.listAnalyses(dynamic.projectId, { query: "Paged", period: "NONE" })).total, 6);
      assert.deepEqual(await repoOther.listAnalyses(dynamic.projectId, { ...options, after: first.nextCursor }), second);
      assert.deepEqual(await repoOther.listProjects(), await repo.listProjects());
      assert.equal((await repo.listAnalyses(dynamic.projectId, { analysisId: third.items[0]!.id })).items[0]!.id, third.items[0]!.id);
      for (const query of [{ limit: 0 }, { limit: 101 }, { after: "bad" }, { status: "BAD" }, { period: "invalid" }, { after: first.nextCursor, before: second.previousCursor }]) {
        await assert.rejects(repo.listAnalyses(dynamic.projectId, query));
      }
      const listSql = statements.findLast(sql => sql.includes("with scoped as materialized"))!;
      assert(listSql && !listSql.includes("c.data") && !listSql.includes("jsonb_array_elements"));
      const handler = createWorkbookHandler({ async authenticate() { return actor; } }, () => repo);
      const page = await handler(new Request(`http://localhost/api/workbook?view=analyses&projectId=${dynamic.projectId}&limit=2&query=Paged`));
      assert.equal(page.status, 200); assert.equal((await page.json()).items.length, 2);
      assert.equal((await handler(new Request(`http://localhost/api/workbook?view=analyses&projectId=${dynamic.projectId}&limit=101`))).status, 400);
    });
    await t.test("missing date projection reports a required upgrade without reading workbook JSON", async () => {
      const handler = createWorkbookHandler({ async authenticate() { return actor; } }, () => repo);
      await admin!.unsafe("alter table procurement.current_workbooks rename column analysis_date to pending_analysis_date");
      try {
        const response = await handler(new Request(`http://localhost/api/workbook?view=analyses&projectId=${dynamic.projectId}`));
        assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: "STORAGE_UPGRADE_REQUIRED" });
        assert(await repo.current(dynamic.analysisId));
      } finally { await admin!.unsafe("alter table procurement.current_workbooks rename column pending_analysis_date to analysis_date"); }
    });
    await t.test("independent Analysis saves progress while another Analysis is locked", async () => {
      const first = await repo.current(dynamic.analysisId); assert(first);
      const otherId = (await repo.listAnalyses(dynamic.projectId, { query: "Paged" })).items[0]!.id;
      const second = await repo.current(otherId); assert(second);
      let waiting: Promise<Awaited<ReturnType<typeof repo.save>>> | undefined;
      try {
        await admin!.begin(async tx => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${'analysis:' + dynamic.analysisId},0))`;
          waiting = repo.save({ snapshot: numericCell(first.snapshot, dynamic.workbook!.offers[0]!.baseCellId, "26000"), configuration: first.configuration, expectedVersion: first.version, mutationId: id<"mutation">() }, actor);
          let locked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const [lock] = await tx`select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting`;
            if (lock!.waiting) { locked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert(locked, "First Save must be waiting on its Analysis lock.");
          const locks = await tx`select mode from pg_locks where locktype='advisory' and granted and pid<>pg_backend_pid()`;
          assert(locks.some(lock => lock.mode === "ShareLock"));
          const result = await repo.save({ snapshot: second.snapshot, configuration: second.configuration, expectedVersion: second.version, mutationId: id<"mutation">() }, actor);
          assert.equal(result.status, "SAVED");
        });
      } finally { if (waiting) assert.equal((await waiting).status, "SAVED"); }
    });
    await t.test("existing Save uses a bounded query budget and runtime guards remain fail-closed", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      statements.length = 0;
      const result = await repo.save({ snapshot: numericCell(saved.snapshot, dynamic.workbook!.offers[0]!.baseCellId, "27000"), configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
      assert.equal(result.status, "SAVED"); assert(statements.length <= 11, `Save used ${statements.length} queries.`);
      t.diagnostic(`Existing Save: ${statements.length} SQL commands including BEGIN/COMMIT; previously 17 by code inspection.`);
      await admin!.unsafe("alter role procurement_app_test bypassrls");
      try { await assert.rejects(repo.listProjects(), /runtime role policy/); }
      finally { await admin!.unsafe("alter role procurement_app_test nobypassrls"); }
      await admin!.unsafe("grant update(owner_id) on procurement.current_workbooks to procurement_runtime");
      try { await assert.rejects(repo.listProjects(), /runtime role policy/); }
      finally { await admin!.unsafe("revoke update(owner_id) on procurement.current_workbooks from procurement_runtime"); }
      assert.deepEqual(await repo.current(dynamic.analysisId), result.status === "SAVED" ? result.workbook : null);
    });
    await t.test("project deletion races with Save without leaving or resurrecting partial data", async () => {
      const s = currentSnapshot(prepareVendorColumns(createProcurementWorkbook("Delete race", "Race")));
      const first = await repo.save({ snapshot: s, configuration: s.workbook!.configuration, expectedVersion: null, mutationId: id<"mutation">() }, actor);
      assert(first.status === "SAVED");
      const [saved, deleted] = await Promise.all([
        repo.save({ snapshot: s, configuration: first.workbook.configuration, expectedVersion: first.workbook.version, mutationId: id<"mutation">() }, actor),
        repo.deleteProject(s.projectId, actor),
      ]);
      assert(saved.status === "SAVED" || saved.status === "CONFLICT"); assert(deleted.deleted);
      assert.equal(await repo.current(s.analysisId), null);
      const remaining = await admin!`select 1 from procurement.projects where id=${s.projectId}
        union all select 1 from procurement.analyses where project_id=${s.projectId}
        union all select 1 from procurement.current_workbooks where project_id=${s.projectId}`;
      assert.equal(remaining.length, 0);
    });
    await t.test("manual PPH formula and dependent vendor conversion recalculate after reload", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved?.configuration);
      const original = saved.snapshot;
      const next = currentSnapshot(numericCell(original, dynamic.workbook!.offers[0]!.baseCellId, "25000"));
      const engine = new FormulaEngine(saved.configuration);
      const incremental = engine.recalculate(next, engine.evaluate(original));
      const full = engine.evaluate(next);
      assert.deepEqual(incremental.results, full.results);
      const result = full.results.find(r => r.cellId === pphCell); assert(result && "value" in result);
      assert.equal(result.value, "500");
      const target = next.mappings.find(m => m.sourceCellId === pphCell && m.scope === "INU")!;
      const converted = full.results.find(r => r.cellId === target.targetCellId); assert(converted && "value" in converted);
      assert.equal(converted.value, "500");
      const vendorName = full.results.find(r => r.cellId === vendorNameCell);
      assert(vendorName?.status === "TEXT"); assert.equal(vendorName.text, "Vendor formula");
    });
    await t.test("shared workspace is visible to other users; bad input does not alter saved data", async () => {
      assert(await repoOther.current(dynamic.analysisId));
      assert((await repoOther.listProjects()).some(project => project.id === dynamic.projectId));
      const before = await repo.current(dynamic.analysisId); assert(before);
      const sharedSave = await repoOther.save({ snapshot: before.snapshot, configuration: before.configuration, expectedVersion: null, mutationId: id<"mutation">() }, other);
      assert.equal(sharedSave.status, "CONFLICT");
      const bad = await repo.save({ snapshot: { ...before.snapshot, selectedOfferId: id<"offer">() }, configuration: before.configuration, expectedVersion: before.version, mutationId: id<"mutation">() }, actor);
      assert.equal(bad.status, "REJECTED"); assert.deepEqual(await repo.current(dynamic.analysisId), before);
    });
    await t.test("AHS preserves manual sale, automatic VAT, linked HPP and independent profile volumes after Save", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved?.configuration);
      let s = connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(saved.snapshot)));
      const selections = { ...s.workbook!.selections };
      for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
        const binding = (key: string) => s.workbook!.bindings.find(b => b.profile === profile && b.key === key)!.cellId;
        s = numericCell(s, binding("sale"), profile === "INU" ? "23333.33333" : "20000");
        s = numericCell(s, binding("volume"), profile === "INU" ? "5000000" : "100");
        const hpp = s.formulas.find(f => f.targetCellId === s.profiles[profile].hppBase.cellId)!;
        assert.deepEqual(hpp.referenceCellIds, [binding("cost")]);
        assert.throws(() => setCellFormula(s, hpp.targetCellId, "1"), /HPP/);
      }
      const outcome = await repo.save({ snapshot: s, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
      assert.equal(outcome.status, "SAVED");
      const reloaded = await repo.current(dynamic.analysisId); assert(reloaded?.configuration);
      assert.deepEqual(reloaded.snapshot.workbook!.selections, selections);
      for (const profile of ["INU", "SOLAR_BAWAH"] as const) {
        const snapshot = changeSheetProfile(reloaded.snapshot, profile);
        assert.equal(snapshot.selectedOfferId, selections[profile]);
        const run = new FormulaEngine(reloaded.configuration).evaluate(snapshot);
        const result = (address: string): string => {
          const cellId = snapshot.workbook!.cells.find(c => c.address === address && snapshot.worksheets
            .flatMap(w => w.tables.flatMap(t => t.cells)).some(cell => cell.id === c.cellId && cell.scope === profile))!.cellId;
          const value = run.results.find(r => r.cellId === cellId); assert(value && "value" in value);
          return value.value;
        };
        assert.equal(result(profile === "INU" ? "I13" : "I12"), profile === "INU" ? "2566.6666663" : "2200");
        assert.equal(result(profile === "INU" ? "K13" : "K12"), profile === "INU" ? "12833333331.5" : "220000");
      }
    });
    await t.test("custom AHS groups survive repeated Save and reload in both workbook layouts", async () => {
      for (const seed of [dynamic, legacy]) {
        let saved = await repo.current(seed.analysisId); assert(saved?.configuration);
        let s = changeSheetProfile(connectAhsVolumes(saved.snapshot), "SOLAR_BAWAH");
        s = numericCell(s, ahsVolumeSource(s, "SOLAR_BAWAH")!.id, "100");
        s = addAhsItem(s, null, "Administrasi", "Biaya tambahan");
        const group = ahsGroups(s).at(-1)!, item = group.items[0]!;
        for (const amount of [30, 31, 32]) {
          s = currentSnapshot(numericCell(s, item.priceCellId, String(amount)));
          const configuration = s.workbook?.configuration ?? legacyConfiguration(s, saved.configuration);
          const outcome = await repo.save({ snapshot: s, configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
          assert.equal(outcome.status, "SAVED");
          saved = await repo.current(seed.analysisId); assert(saved?.configuration);
          assert.deepEqual(saved.snapshot.ahsGroups, s.ahsGroups);
          assert.deepEqual(ahsCell(saved.snapshot, item.priceCellId)!.source, ahsCell(s, item.priceCellId)!.source);
          const hydrated = connectAhsVolumes(prepareLegacySheet(saved.snapshot));
          assert.equal(canonicalJson(hydrated), canonicalJson(saved.snapshot));
          const result = new FormulaEngine(saved.configuration).evaluate(hydrated).provisional!.results.find(r => r.cellId === item.totalCellId);
          assert(result && "value" in result); assert.equal(Number(result.value), amount * 100);
          s = saved.snapshot;
        }
        const [row] = await admin!`select count(*)::int as count from procurement.current_workbooks where analysis_id=${seed.analysisId}`;
        assert.equal(row!.count, 1);
      }
    });
    await t.test("all AHS sections persist through repeated Save without overwriting earlier groups", async () => {
      for (const seed of [dynamic, legacy]) {
        let saved = await repo.current(seed.analysisId); assert(saved?.configuration);
        let s = changeSheetProfile(prepareAhsRollups(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(saved.snapshot)))), "SOLAR_BAWAH");
        const costs = canonicalJson(ahsGroups(s));
        const volume = ahsVolumeSource(s, s.activeProfile)!.id;
        s = numericCell(s, volume, "1000");
        s = addAhsItem(s, null, "Layanan tambahan", "Pendapatan lain", "PENDAPATAN");
        const income = ahsGroups(s, s.activeProfile, "PENDAPATAN").at(-1)!.items[0]!;
        s = addAhsField(s, "INFORMASI", "PIC", "TEXT");
        const info = ahsFields(s, "INFORMASI")[0]!;
        s = setCellFormula(s, info.valueCellId, '"Ibnu"');
        s = setCellFormula(s, info.labelCellId, '"PIC formula"');
        const incomeGroup = ahsGroups(s, s.activeProfile, "PENDAPATAN").at(-1)!;
        s = setCellFormula(s, incomeGroup.labelCellId!, `@{${info.valueCellId}}`);
        s = setCellFormula(s, income.labelCellId!, resolveFormula(canvasCellAddresses(s).get(info.labelCellId)!, s, income.labelCellId!));
        s = addAhsField(s, "LABA", "Pembagian laba", "IDR");
        const indicator = ahsFields(s, "LABA")[0]!;
        const profit = ahsRoleCell(s, s.activeProfile, "L36", "LABA BERSIH")!.id;
        s = setCellFormula(s, indicator.valueCellId, `@{${profit}}*0.1`);
        for (const amount of [200, 201]) {
          s = currentSnapshot(setCellFormula(s, income.priceCellId, `(${amount}*2)/2`));
          const configuration = s.workbook?.configuration ?? legacyConfiguration(s, saved.configuration);
          const result = await repo.save({ snapshot: s, configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
          assert.equal(result.status, "SAVED");
          saved = await repo.current(seed.analysisId); assert(saved?.configuration);
          assert.equal(canonicalJson(saved.snapshot), canonicalJson(s));
          assert.equal(canonicalJson(ahsGroups(saved.snapshot)), costs);
          const prepared = prepareAhsRollups(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(saved.snapshot)))));
          assert.equal(canonicalJson(prepared), canonicalJson(saved.snapshot));
          const run = new FormulaEngine(saved.configuration).evaluate(prepared);
          assert.equal(ahsLabel(prepared, incomeGroup, run.provisional!.results), "Ibnu");
          assert.equal(ahsLabel(prepared, income, run.provisional!.results), "PIC formula");
          const labelExpression = prepared.formulas.find(f => f.targetCellId === income.labelCellId)!.expression;
          assert.equal(displayFormula(labelExpression, prepared, income.labelCellId!), canvasCellAddresses(prepared).get(info.labelCellId));
          const total = run.provisional!.results.find(r => r.cellId === income.totalCellId);
          assert(total && "value" in total); assert.equal(Number(total.value), amount * 1000);
          const name = run.results.find(r => r.cellId === info.valueCellId);
          assert(name?.status === "TEXT"); assert.equal(name.text, "Ibnu");
          s = saved.snapshot;
        }
        const include = ahsRoleCell(s, s.activeProfile, "J8", "Harga Include")!.id;
        const sale = ahsRoleCell(s, s.activeProfile, "I11", "Harga Jual · Harga Dasar")!.id;
        s = setCellInput(s, include, { kind: "NUMERIC_TEXT", text: "1110" });
        s = currentSnapshot(setCellFormula(s, sale, `@{${include}}/1.11`));
        const configuration = s.workbook?.configuration ?? legacyConfiguration(s, saved.configuration);
        await repo.save({ snapshot: s, configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor);
        saved = await repo.current(seed.analysisId); assert(saved?.configuration);
        const prepared = prepareAhsRollups(connectAhsVolumes(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(saved.snapshot)))));
        assert.equal(canonicalJson(prepared), canonicalJson(s), "reload must preserve manual totals and user sale formulas");
        const saleResult = new FormulaEngine(saved.configuration).evaluate(prepared).provisional!.results.find(r => r.cellId === sale);
        assert(saleResult && "value" in saleResult); assert.equal(saleResult.value, "1000");
        const [row] = await admin!`select count(*)::int as count from procurement.current_workbooks where analysis_id=${seed.analysisId}`;
        assert.equal(row!.count, 1);
      }
    });
    await t.test("canonical stored values occur only in offers; dangling references are rejected", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const data = encodeWorkbook(saved.snapshot, saved.configuration);
      assert(!("configuration" in data.state.workbook!));
      const cell = data.state.worksheets.flatMap(w => w.tables.flatMap(t => t.cells)).find(c => c.id === dynamic.workbook!.offers[0]!.baseCellId)!;
      assert.equal(cell.source.kind, "OFFER_VALUE"); assert(!("input" in cell.source));
      const invalid = structuredClone(data);
      invalid.state.analysis.offers = invalid.state.analysis.offers.map(o => ({ ...o, values: [] }));
      assert.throws(() => decodeWorkbook(invalid, { analysisId: dynamic.analysisId, projectId: dynamic.projectId, analysisName: "Dynamic", projectName: dynamic.project.name }));
    });
    await t.test("HTTP Save/current use current repository; old endpoints and unauthenticated access fail", async () => {
      const handler = createWorkbookHandler({ async authenticate() { return actor; } }, () => repo);
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const request = { snapshot: saved.snapshot, configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() };
      const response = await handler(new Request("http://localhost/api/workbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "SAVE", request }) }));
      assert.equal(response.status, 200);
      const loaded = await handler(new Request(`http://localhost/api/workbook?analysisId=${dynamic.analysisId}`));
      assert.equal(loaded.status, 200);
      const loadedBody = await loaded.json();
      assert.equal(loadedBody.snapshot.analysisId, dynamic.analysisId);
      assert.equal(loadedBody.analysisMetadata.id, dynamic.analysisId);
      assert.equal(loadedBody.analysisMetadata.version, loadedBody.version);
      assert.equal(loadedBody.analysisMetadata.name, loadedBody.snapshot.analysis.analysis.name);
      assert.equal(loadedBody.analysisMetadata.status, (await repo.listAnalyses(dynamic.projectId, { analysisId: dynamic.analysisId })).items[0]!.status);
      const timing = loaded.headers.get("Server-Timing")!;
      for (const stage of ["auth", "db_connect", "db_setup", "db_identity", "db_role", "db_privileges", "db_claims", "db_query", "decode", "stored_validation", "serialize", "total"]) {
        assert.match(timing, new RegExp(`(?:^|, )${stage};dur=\\d+\\.\\d{2}(?:,|$)`));
      }
      const held = await handler(new Request(`http://localhost/api/workbook?analysisId=${dynamic.analysisId}`));
      assert.equal((await held.json()).analysisMetadata.version, loadedBody.version);
      const metadata = { operation: "UPDATE_ANALYSIS", analysisId: dynamic.analysisId, name: saved.snapshot.analysis.analysis.name, status: "HOLD" };
      const update = (command: object) => handler(new Request("http://localhost/api/workbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) }));
      assert.equal((await update(metadata)).status, 400);
      const command = { ...metadata, expectedVersion: saved.version, mutationId: id<"mutation">() };
      const updated = await update(command); assert.equal(updated.status, 200);
      const updatedBody = await updated.json(); assert.notEqual(updatedBody.version, saved.version);
      const readStart = statements.length;
      const synchronized = await (await handler(new Request(`http://localhost/api/workbook?analysisId=${dynamic.analysisId}`))).json();
      assert.deepEqual(synchronized.analysisMetadata, updatedBody);
      assert.equal(synchronized.version, updatedBody.version);
      assert(!statements.slice(readStart).some(sql => sql.includes("with scoped as materialized")));
      assert.deepEqual(await (await update(command)).json(), updatedBody);
      assert.equal((await update({ ...command, name: "Different" })).status, 400);
      assert.equal((await update({ ...command, mutationId: id<"mutation">() })).status, 409);
      for (const view of ["history", "revision", "replay", "runs", "latest-run"]) assert.equal((await handler(new Request(`http://localhost/api/workbook?view=${view}`))).status, 400);
      const before = await repo.current(dynamic.analysisId);
      for (const operation of ["RESTORE", "REPLAY", "CALCULATE"]) {
        const obsolete = await handler(new Request("http://localhost/api/workbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, request }) }));
        assert.equal(obsolete.status, 400);
      }
      assert.deepEqual(await repo.current(dynamic.analysisId), before);
      const denied = createWorkbookHandler({ async authenticate() { throw new AuthenticationError(); } }, () => repo);
      assert.equal((await denied(new Request("http://localhost/api/workbook"))).status, 401);
    });
    await t.test("deleting an analysis removes its current workbook and database row", async () => {
      const handler = createWorkbookHandler({ async authenticate() { return actor; } }, () => repo);
      const response = await handler(new Request("http://localhost/api/workbook", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "DELETE_ANALYSIS", analysisId: legacy.analysisId }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deleted: true, analysisId: legacy.analysisId });
      assert.equal(await repo.current(legacy.analysisId), null);
      const [analysis] = await admin!`select count(*)::int as count from procurement.analyses where id = ${legacy.analysisId}`;
      const [workbook] = await admin!`select count(*)::int as count from procurement.current_workbooks where analysis_id = ${legacy.analysisId}`;
      assert.equal(analysis!.count, 0); assert.equal(workbook!.count, 0);
    });
    await t.test("deleting a project removes its analyses and current workbooks", async () => {
      const handler = createWorkbookHandler({ async authenticate() { return actor; } }, () => repo);
      const response = await handler(new Request("http://localhost/api/workbook", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "DELETE_PROJECT", projectId: dynamic.projectId }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deleted: true, projectId: dynamic.projectId });
      const [project] = await admin!`select count(*)::int as count from procurement.projects where id = ${dynamic.projectId}`;
      const [analyses] = await admin!`select count(*)::int as count from procurement.analyses where project_id = ${dynamic.projectId}`;
      const [workbooks] = await admin!`select count(*)::int as count from procurement.current_workbooks where project_id = ${dynamic.projectId}`;
      assert.equal(project!.count, 0); assert.equal(analyses!.count, 0); assert.equal(workbooks!.count, 0);
    });
  } finally {
    await login?.end({ timeout: 3 }); await admin?.end({ timeout: 3 });
    if (started) command("pg_ctl", ["-D", join(directory, "db"), "-m", "fast", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
