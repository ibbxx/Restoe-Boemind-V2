"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Image from "next/image";
import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import { updateCellInput } from "../domain/commands.ts";
import { emptyWorkbook, appendField } from "../domain/workflow.ts";
import { captureSnapshot } from "../domain/snapshots.ts";
import type { StoredRevision } from "../persistence/contracts.ts";
import type { SaveRequest, SaveOutcome } from "../application/contracts.ts";
import { FormulaEngine } from "../engine/formula-engine.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { api, ApiError, post, saveRequestBody } from "./workbook-client.ts";
import { WorksheetSurface } from "./worksheet-surface.tsx";
import { createProcurementWorkbook, prepareNumericBlanks } from "../domain/procurement-template.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../domain/legacy-sheet.ts";
import { prepareVendorColumns, prepareSelectedVendorMappings, selectSheetOffer } from "../domain/dynamic-workflow.ts";
import { recordVendorRevisions } from "../domain/vendor-revisions.ts";

type ProjectListItem = { id: string; name: string };
type AnalysisListItem = { id: string; name: string; project_id: string };
function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }

export function ProcurementWorkspace() {
  const [actor, setActor] = useState<StableId<"user"> | null>(null);
  const [busy, setBusy] = useState(true), [message, setMessage] = useState("Memeriksa sesi…"), [error, setError] = useState("");
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisListItem[]>([]);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [head, setHead] = useState<StableId<"revision"> | null>(null), [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<readonly StoredRevision[]>([]), [, setRuns] = useState<readonly EngineRun[]>([]);
  const [configuration, setConfiguration] = useState<EngineConfiguration | null>(null);
  const snapshotRef = useRef<WorkbookSnapshot | null>(null);
  const previewRef = useRef<EngineRun | null>(null);
  const [calculatedPreview, setCalculatedPreview] = useState<{ snapshotId: string; run: EngineRun | null; error: string } | null>(null);
  const pendingSave = useRef<SaveRequest | null>(null);
  const lastActor = useRef<StableId<"user"> | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const [newWorkbookProjectId, setNewWorkbookProjectId] = useState<string | null>(null);

  async function load(analysisId: string) {
    const [stored, revisions, calculations] = await Promise.all([
      api<StoredRevision | null>(`/api/workbook?analysisId=${analysisId}`),
      api<readonly StoredRevision[]>(`/api/workbook?view=history&analysisId=${analysisId}`),
      api<readonly EngineRun[]>(`/api/workbook?view=runs&analysisId=${analysisId}`),
    ]);
    if (!stored) throw new ApiError("NOT_FOUND_OR_FORBIDDEN");
    let s = prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(captureSnapshot(stored.revision.snapshot))))));
    const matchingRuns = calculations.filter(r => s.policy.status === "CONFIGURED" && r.policyVersionId === s.policy.versionId);
    const sourceId = stored.revision.restoredFrom?.snapshotId ?? s.id;
    const inventory = (value: WorkbookSnapshot) => value.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))).sort().join(",");
    const matching = matchingRuns.findLast(r => r.snapshotId === sourceId) ?? matchingRuns.findLast(r => inventory(r.manifest.snapshot) === inventory(s));
    let config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, matching?.manifest.configuration ?? null);
    s = recordVendorRevisions(s, config);
    const mappingActor = actor ?? lastActor.current;
    if (mappingActor) s = prepareSelectedVendorMappings(s, mappingActor);
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    previewRef.current = null; snapshotRef.current = s; setSnapshot(s); setHead(stored.revision.revisionId); setHistory(revisions); setRuns(calculations);
    setConfiguration(config); setDirty(s.id !== stored.revision.snapshot.id); pendingSave.current = null;
    window.history.replaceState(null, "", "?analysisId=" + analysisId);
  }
  async function refreshProjects() { setProjects(await api("/api/workbook?view=projects")); }
  async function showProject(projectId: string) {
    if (expandedProjectId === projectId) { setExpandedProjectId(null); setAnalyses([]); return; }
    setExpandedProjectId(projectId); setNewWorkbookProjectId(null);
    setAnalyses(await api(`/api/workbook?view=analyses&projectId=${projectId}`));
    setMessage("Pilih lembar perhitungan yang akan dibuka.");
  }
  function openAnalysis(analysisId: string) {
    if (dirty && !window.confirm("Buka Analysis lain dan buang draft yang belum disimpan?")) return;
    void task(async () => { await load(analysisId); setMessage("Analysis dimuat."); });
  }
  function showProjectList() {
    if (dirty && !window.confirm("Kembali ke daftar proyek dan buang draft yang belum disimpan?")) return;
    const projectId = snapshotRef.current?.projectId ?? null;
    snapshotRef.current = null; setSnapshot(null); setHead(null); setHistory([]); setRuns([]); setConfiguration(null);
    setDirty(false); setNewWorkbookProjectId(null); pendingSave.current = null; window.history.replaceState(null, "", "/");
    if (projectId) void task(async () => { setExpandedProjectId(projectId); setAnalyses(await api(`/api/workbook?view=analyses&projectId=${projectId}`)); setMessage("Daftar proyek."); });
    else setMessage("Daftar proyek.");
  }
  async function task(action: () => void | Promise<void>) {
    setBusy(true); setError(""); setMessage("Memproses…");
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operasi gagal."); setMessage("");
      if (cause instanceof ApiError && cause.code === "UNAUTHENTICATED") setActor(null);
    } finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api<{ actorId: StableId<"user"> }>("/api/session");
        if (!active) return;
        lastActor.current = session.actorId; setActor(session.actorId); await refreshProjects();
        const selected = new URLSearchParams(window.location.search).get("analysisId");
        if (selected) await load(parseStableId<"analysis">(selected));
        if (active) setMessage("Siap.");
      } catch (cause) {
        if (active) {
          setMessage("");
          if (!(cause instanceof ApiError && cause.code === "UNAUTHENTICATED")) setError(cause instanceof Error ? cause.message : "Sesi gagal dimuat.");
        }
      } finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const channel = new BroadcastChannel("procurement-session"); sessionChannel.current = channel;
    channel.onmessage = event => {
      if (event.data?.actorId !== lastActor.current) { setActor(null); setMessage("Sesi berubah di tab lain. Silakan masuk kembali."); }
    };
    return () => { channel.close(); sessionChannel.current = null; };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function edit(s: WorkbookSnapshot, config = s.workbook ? s.workbook.configuration : configuration) {
    s = prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s)))));
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    s = recordVendorRevisions(s, config);
    if (actor) s = prepareSelectedVendorMappings(s, actor);
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    snapshotRef.current = s; setSnapshot(s); setConfiguration(config); setDirty(true); pendingSave.current = null; setError(""); setMessage("Draft berubah; belum disimpan.");
  }
  function mutate(action: () => void) { try { action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Input tidak valid."); } }
  useEffect(() => {
    if (!snapshot || !configuration) return;
    let active = true;
    const timer = window.setTimeout(() => {
      try {
        const engine = new FormulaEngine(configuration);
        const previous = previewRef.current;
        const run = previous && previous.manifest.snapshot.analysisId === snapshot.analysisId &&
          previous.manifest.snapshot.activeProfile === snapshot.activeProfile
          ? engine.recalculate(snapshot, previous) : engine.evaluate(snapshot);
        if (active) { previewRef.current = run; setCalculatedPreview({ snapshotId: snapshot.id, run, error: "" }); }
      } catch (cause) {
        if (active) setCalculatedPreview({ snapshotId: snapshot.id, run: null, error: cause instanceof Error ? cause.message : "Konfigurasi tidak valid." });
      }
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [snapshot, configuration]);
  const preview = calculatedPreview?.snapshotId === snapshot?.id ? calculatedPreview : null;
  async function save(intent: SaveRequest["intent"] = "SAVE_DRAFT") {
    const formulaInput = document.querySelector<HTMLInputElement>('[data-testid="procurement-sheet"] .formula-bar-form input[data-editing="true"]');
    if (formulaInput) {
      const form = formulaInput.form;
      form?.requestSubmit();
      if (form?.dataset.commitFailed === "true") throw new Error("Perbaiki input sel sebelum menyimpan.");
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.matches('[data-testid="procurement-sheet"] .sheet-input')) active.blur();
    if (document.querySelector('[data-testid="procurement-sheet"] .sheet-input[data-invalid="true"]')) throw new Error("Perbaiki input sel sebelum menyimpan.");
    const current = snapshotRef.current;
    if (!current) return;
    const request: SaveRequest = pendingSave.current?.intent === intent ? pendingSave.current : {
      intent, expectedRevisionId: head, mutationId: id<"mutation">(), snapshot: current };
    pendingSave.current = request;
    const outcome = await api<SaveOutcome>("/api/workbook", { method: "POST", body: saveRequestBody(request) });
    if (outcome.status !== "SAVED") throw new ApiError(outcome.code);
    pendingSave.current = null;
    snapshotRef.current = outcome.revision.snapshot; setSnapshot(outcome.revision.snapshot); setHead(outcome.revision.revisionId); setDirty(false);
    window.history.replaceState(null, "", "?analysisId=" + current.analysisId);
    setMessage("Draft tersimpan.");
    await refreshProjects();
    setHistory(await api(`/api/workbook?view=history&analysisId=${current.analysisId}`));
    if (configuration) {
      setMessage("Draft tersimpan; menghitung preview…");
      const result = await post<{ status: "STORED_PREVIEW"; run: EngineRun }>("CALCULATE", {
        analysisId: current.analysisId, revisionId: outcome.revision.revisionId, configuration });
      setRuns(prior => [...prior, result.run]); setMessage("Draft dan preview tersimpan.");
    }
  }

  return <main className={actor ? "workbook-app" : "login-app"}>
    <header className="app-header">
      <div className="app-brand"><Image src="/image.png" width={38} height={39} alt="" priority />
        <div><h1>Sistem Evaluasi Vendor</h1>{snapshot && <span>{snapshot.project.name}</span>}</div>
      </div>
      {actor && <nav className="app-actions" aria-label="Tindakan workspace">
        {dirty && <span className="unsaved-state">Belum disimpan</span>}
        {snapshot && <button type="button" onClick={showProjectList}>Daftar proyek</button>}
        {snapshot && <button aria-label="Simpan workbook" disabled={busy} onClick={() => void task(() => save())}>Simpan</button>}
        <button disabled={busy} onClick={() => {
          if (dirty && !window.confirm("Keluar akan membuang draft yang belum disimpan. Lanjutkan?")) return;
          void task(async () => { await api("/api/session", { method: "DELETE" }, false); setActor(null); snapshotRef.current = null; setSnapshot(null); setProjects([]); setAnalyses([]); setExpandedProjectId(null);
            sessionChannel.current?.postMessage({ actorId: null }); lastActor.current = null;
            setHistory([]); setRuns([]); setConfiguration(null); setDirty(false); pendingSave.current = null; window.history.replaceState(null, "", "/"); setMessage("Berhasil keluar."); });
        }}>Keluar</button>
      </nav>}
    </header>
    <div className="operation-status" role="status" aria-label="Status operasi" aria-live="polite">{busy ? "Memproses…" : message}</div>
    {(error || preview?.error) && <p role="alert">{error || `Perhitungan gagal: ${preview?.error}`}</p>}
    {!actor ? <section><h2>Masuk</h2><form onSubmit={event => { const form = submit(event); const element = event.currentTarget;
      const password = element.elements.namedItem("password"); if (password instanceof HTMLInputElement) password.value = "";
      void task(async () => {
        const session = await api<{ actorId: StableId<"user"> }>("/api/session", { method: "POST", body: JSON.stringify({ operation: "LOGIN", email: field(form, "email"), password: String(form.get("password")) }) }, false);
        if (lastActor.current !== session.actorId) {
          snapshotRef.current = null; setSnapshot(null); setHistory([]); setRuns([]); setConfiguration(null); setHead(null); setDirty(false); pendingSave.current = null;
          setProjects([]); setAnalyses([]); setExpandedProjectId(null); window.history.replaceState(null, "", "/");
        }
        lastActor.current = session.actorId; setActor(session.actorId); sessionChannel.current?.postMessage({ actorId: session.actorId });
        element.reset(); await refreshProjects(); setMessage("Berhasil masuk.");
      }); }}><fieldset disabled={busy}><label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Kata sandi<input name="password" type="password" autoComplete="current-password" required /></label><button>Masuk</button></fieldset></form></section>
    : <>
      {!snapshot ? <section className="project-index" aria-labelledby="project-index-title">
        <header className="project-index-heading">
          <div><p className="eyebrow">DAFTAR PEKERJAAN</p><h2 id="project-index-title">Proyek berjalan</h2><p>Setiap proyek berisi satu atau beberapa analisis (lembar evaluasi).</p></div>
          <button type="button" disabled={busy} onClick={() => setNewWorkbookProjectId("")}>＋ Proyek baru</button>
        </header>
        {newWorkbookProjectId !== null && <form className="project-create-form" onSubmit={event => {
          const form = submit(event);
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          mutate(() => {
            const existing = projects.find(p => p.id === newWorkbookProjectId);
            const projectId = existing ? parseStableId<"project">(existing.id) : undefined;
            const projectName = existing?.name ?? field(form, "projectName");
            const analysisName = field(form, "analysisName");
            const next = submitter?.value === "empty"
              ? emptyWorkbook(projectName, analysisName, projectId)
              : createProcurementWorkbook(projectName, analysisName, projectId);
            edit(next, next.workbook?.configuration ?? null);
            setHead(null); setHistory([]); setRuns([]); setNewWorkbookProjectId(null);
            window.history.replaceState(null, "", "/");
          });
        }}><h3>{newWorkbookProjectId ? "Tambah Analysis" : "Proyek baru"}</h3>
          {newWorkbookProjectId ? <p>Proyek: {projects.find(p => p.id === newWorkbookProjectId)?.name}</p>
            : <label>Nama proyek<input name="projectName" required /></label>}
          <label>Nama Analysis<input name="analysisName" required /></label>
          <div className="project-create-actions"><button type="submit" value="template">Buat dari template</button>
            <button type="submit" value="empty">Buat workbook kosong</button>
            <button type="button" onClick={() => setNewWorkbookProjectId(null)}>Batal</button></div>
        </form>}
        {projects.length ? <ol className="project-list">
          {projects.map((project, index) => {
            const expanded = expandedProjectId === project.id;
            return <li key={project.id} className={expanded ? "project-row is-open" : "project-row"}>
              <button type="button" className="project-row-button" aria-expanded={expanded}
                onClick={() => void task(() => showProject(project.id))}>
                <span className="project-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="project-name">{project.name}</span>
                <span className="project-action">{expanded ? "Tutup" : "Buka proyek"}</span>
              </button>
              {expanded && <div className="analysis-list" aria-label={`Lembar perhitungan ${project.name}`}>
                {analyses.length ? analyses.map(analysis => <button type="button" key={analysis.id}
                  className="analysis-row" onClick={() => openAnalysis(analysis.id)}>
                  <span>{analysis.name}</span><span>Buka worksheet →</span>
                </button>) : <p>Belum ada analisis dalam proyek ini.</p>}
                <button type="button" className="analysis-create" onClick={() => setNewWorkbookProjectId(project.id)}>＋ Tambah analisis</button>
              </div>}
            </li>;
          })}
        </ol> : <div className="project-empty"><p>Belum ada proyek tersimpan.</p><button type="button" onClick={() => setNewWorkbookProjectId("")}>Buat proyek pertama</button></div>}
      </section> : <WorksheetSurface
        snapshot={snapshot}
        run={preview?.run ?? null}
        disabled={busy}
        actor={actor}
        history={history}
        onChange={next => {
          if (next.workbook) { edit(next); return; }
          const remaining = new Set(next.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
          const units = configuration?.units.filter(u => remaining.has(u.cellId));
          edit(next, configuration && units && units.length !== configuration.units.length ? { ...configuration, version: id<"policy">(), units } : configuration);
        }}
        onError={setError}
        onEditing={() => { setDirty(true); pendingSave.current = null; }}
        onSave={() => void task(() => save())}
        onSelectOffer={revisionId => { if (snapshot && actor) mutate(() => {
          edit(selectSheetOffer(snapshot, parseStableId<"offer-revision">(revisionId), actor));
        }); }}
        onInput={(stage, label, value, kind, cell) => { if (snapshot) mutate(() => {
          const input = value.trim() ? { kind, text: value } : { kind: "UNSET" as const };
          if (cell) edit(updateCellInput(snapshot, cell.scope, cell.id, input));
          else edit(appendField(snapshot, stage, kind === "TEXT" && stage === "EVALUASI_VENDOR" ? "SHARED" : snapshot.activeProfile, label, input).snapshot);
        }); }}
      />}
      {snapshot && <div className="sheet-caption">{snapshot.analysis.analysis.name} · Preview NONFINAL{preview?.run?.provisional?.status === "ERROR" ? " · ERROR" : ""}</div>}
    </>}
  </main>;
}
