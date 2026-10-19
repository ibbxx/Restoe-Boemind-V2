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
import { connectAhsVolumes } from "../src/domain/ahs-volume.ts";
import { currentSnapshot } from "../src/domain/current-workbook.ts";
import { createStableId as id } from "../src/domain/ids.ts";
import { canonicalJson } from "../src/domain/snapshots.ts";
import type { WorkbookSnapshot } from "../src/domain/contracts.ts";
import { FormulaEngine } from "../src/engine/formula-engine.ts";
import type { SaveRequest } from "../src/application/contracts.ts";
import { prepareCalculationPolicy } from "../src/domain/calculation-policy.ts";
import { setCellFormula } from "../src/domain/structure.ts";
import { PostgresWorkbookRepository } from "../src/persistence/postgres-workbook-repository.ts";
import { encodeWorkbook, decodeWorkbook } from "../src/persistence/workbook-data.ts";
import { createWorkbookHandler } from "../src/server/workbook-handler.ts";
import { AuthenticationError } from "../src/server/supabase-auth.ts";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = readdirSync(migrations).filter(f => f.endsWith(".sql")).sort();
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
  try {
    command("initdb", ["-D", join(directory, "db"), "-A", "trust", "-U", "postgres", "--no-locale"]);
    command("pg_ctl", ["-D", join(directory, "db"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]); started = true;
    admin = postgres({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 1, onnotice: () => {} });
    await admin.unsafe(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';`);
    for (const file of migrationFiles.slice(0, -1)) await admin.begin(tx => tx.unsafe(readFileSync(new URL(file, migrations), "utf8")));

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
        await tx.unsafe(readFileSync(new URL(migrationFiles.at(-1)!, migrations), "utf8"));
      }), /Every existing Analysis must have current data/);
      const [old] = await admin!`select to_regclass('procurement.revisions') is not null as present`;
      assert.equal(old!.present, true);
    });
    await t.test("migration retains active inputs, formulas, IDs and numerical results", async () => {
      await admin!.begin(tx => tx.unsafe(readFileSync(new URL(migrationFiles.at(-1)!, migrations), "utf8")));
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
    await admin.unsafe("create role procurement_app_test login noinherit; grant procurement_runtime to procurement_app_test;");
    login = postgres({ host: "127.0.0.1", port, user: "procurement_app_test", database: "postgres", max: 2, onnotice: () => {} });
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
      assert.equal(outcome.status, "SAVED"); assert.equal((await repo.listAnalyses(dynamic.projectId)).length, 2);
      assert.equal((await repo.current(dynamic.analysisId))!.snapshot.analysis.analysis.name, "Dynamic");
    });
    await t.test("simultaneous Saves accept one writer and preserve the latest committed data", async () => {
      const saved = await repo.current(dynamic.analysisId); assert(saved);
      const results = await Promise.all([1, 2].map(n => repo.save({ snapshot: numericCell(saved.snapshot, dynamic.workbook!.offers[0]!.baseCellId, String(22000+n)),
        configuration: saved.configuration, expectedVersion: saved.version, mutationId: id<"mutation">() }, actor)));
      assert.equal(results.filter(r => r.status === "SAVED").length, 1);
      assert.equal(results.filter(r => r.status === "CONFLICT").length, 1);
      const winner = results.find(r => r.status === "SAVED"); assert(winner?.status === "SAVED");
      assert.deepEqual(await repo.current(dynamic.analysisId), winner.workbook);
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
    await t.test("RLS hides other users and rejects writes; bad input does not alter saved data", async () => {
      assert.equal(await repoOther.current(dynamic.analysisId), null);
      assert.deepEqual(await repoOther.listProjects(), []);
      const before = await repo.current(dynamic.analysisId); assert(before);
      await assert.rejects(repoOther.save({ snapshot: before.snapshot, configuration: before.configuration, expectedVersion: null, mutationId: id<"mutation">() }, other));
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
      assert.equal(loaded.status, 200); assert.equal((await loaded.json()).snapshot.analysisId, dynamic.analysisId);
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
  } finally {
    await login?.end({ timeout: 3 }); await admin?.end({ timeout: 3 });
    if (started) command("pg_ctl", ["-D", join(directory, "db"), "-m", "fast", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
