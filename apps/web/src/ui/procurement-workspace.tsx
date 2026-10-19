"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Image from "next/image";
import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import { updateCellInput } from "../domain/commands.ts";
import { emptyWorkbook, appendField, initializeAnalysisDate } from "../domain/workflow.ts";
import { captureSnapshot } from "../domain/snapshots.ts";
import type { SaveRequest, SaveOutcome, SavedWorkbook } from "../application/contracts.ts";
import { FormulaEngine } from "../engine/formula-engine.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { api, ApiError, invalidateSessionRequests, readSession, saveRequestBody } from "./workbook-client.ts";
import { WorksheetSurface } from "./worksheet-surface.tsx";
import { LoadingIndicator } from "./loading-indicator.tsx";
import { createProcurementWorkbook, prepareNumericBlanks } from "../domain/procurement-template.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../domain/legacy-sheet.ts";
import { prepareVendorColumns, prepareSelectedVendorMappings, selectSheetOffer } from "../domain/dynamic-workflow.ts";
import { refreshCurrentOffers } from "../domain/current-offers.ts";
import { connectAhsVolumes } from "../domain/ahs-volume.ts";
import { prepareCalculationPolicy } from "../domain/calculation-policy.ts";

type ProjectListItem = { id: string; name: string };
type AnalysisListItem = { id: string; name: string; project_id: string };
function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }

export function ProcurementWorkspace() {
  const [actor, setActor] = useState<StableId<"user"> | null>(null);
  const [busy, setBusy] = useState(true), [message, setMessage] = useState("Memeriksa sesi…"), [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preparingPrint, setPreparingPrint] = useState(false);
  const loadingLabel = busy ? (saving ? "Menyimpan perubahan…" : "Memproses…") : "Menyiapkan cetakan…";
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisListItem[]>([]);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [dirty, setDirty] = useState(false);
  const [configuration, setConfiguration] = useState<EngineConfiguration | null>(null);
  const configurationRef = useRef<EngineConfiguration | null>(null);
  const snapshotRef = useRef<WorkbookSnapshot | null>(null);
  const previewRef = useRef<EngineRun | null>(null);
  const [calculatedPreview, setCalculatedPreview] = useState<{ snapshotId: string; run: EngineRun | null; error: string } | null>(null);
  const pendingSave = useRef<SaveRequest | null>(null);
  const lastActor = useRef<StableId<"user"> | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const [newWorkbookProjectId, setNewWorkbookProjectId] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState("");
  const volumeErrorRef = useRef("");

  const prepareVolumes = useCallback((s: WorkbookSnapshot) => {
    let issue = "";
    try { s = connectAhsVolumes(s); }
    catch (cause) { issue = cause instanceof Error ? cause.message : "Volume AHS gagal diselaraskan."; }
    volumeErrorRef.current = issue; setVolumeError(issue);
    return s;
  }, []);

  const saveFlight = useRef<Promise<void> | null>(null);
  const workspaceEpoch = useRef(0);
  const savedVersion = useRef<StableId<"version"> | null>(null);
  useEffect(() => () => { workspaceEpoch.current++; }, []);

  const requireLogin = useCallback((status: string) => {
    invalidateSessionRequests(); workspaceEpoch.current++;
    setActor(null); setError(""); setMessage(status); setBusy(false);
  }, []);

  const load = useCallback(async (analysisId: string) => {
    const epoch = ++workspaceEpoch.current, actorId = lastActor.current;
    const stored = await api<SavedWorkbook | null>(`/api/workbook?analysisId=${analysisId}`);
    if (workspaceEpoch.current !== epoch || lastActor.current !== actorId) return;
    if (!stored) throw new ApiError("NOT_FOUND_OR_FORBIDDEN");
    let s = captureSnapshot(stored.snapshot);
    let config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, stored.configuration);
    ({ snapshot: s, configuration: config } = prepareCalculationPolicy(s, config));
    s = prepareVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s))))));
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    s = refreshCurrentOffers(s);
    const mappingActor = lastActor.current;
    if (mappingActor) s = prepareSelectedVendorMappings(s, mappingActor);
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    previewRef.current = null; configurationRef.current = config; snapshotRef.current = s; setSnapshot(s);
    savedVersion.current = stored.version;
    setConfiguration(config); setDirty(s.id !== stored.snapshot.id); pendingSave.current = null;
    window.history.replaceState(null, "", "?analysisId=" + analysisId);
  }, [prepareVolumes]);
  const refreshProjects = useCallback(async () => {
    const actorId = lastActor.current;
    const next = await api<ProjectListItem[]>("/api/workbook?view=projects");
    if (lastActor.current === actorId) setProjects(next);
  }, []);
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
    workspaceEpoch.current++;
    const projectId = snapshotRef.current?.projectId ?? null;
    snapshotRef.current = null; configurationRef.current = null; setSnapshot(null); savedVersion.current = null; setConfiguration(null);
    setDirty(false); setNewWorkbookProjectId(null); pendingSave.current = null; window.history.replaceState(null, "", "/");
    if (projectId) void task(async () => { setExpandedProjectId(projectId); setAnalyses(await api(`/api/workbook?view=analyses&projectId=${projectId}`)); setMessage("Daftar proyek."); });
    else setMessage("Daftar proyek.");
  }
  async function task(action: () => void | Promise<void>, isSave = false) {
    setBusy(true); setSaving(isSave); setError(""); setMessage("Memproses…");
    try { await action(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === "SESSION_CHANGED") return;
      if (cause instanceof ApiError && cause.code === "UNAUTHENTICATED") {
        requireLogin("Sesi berakhir. Silakan masuk kembali."); return;
      }
      setError(cause instanceof Error ? cause.message : "Operasi gagal."); setMessage("");
    } finally { setBusy(false); setSaving(false); }
  }
  useEffect(() => {
    let active = true, epoch = workspaceEpoch.current;
    const current = () => active && workspaceEpoch.current === epoch;
    void (async () => {
      try {
        const session = await readSession();
        if (!current()) return;
        if (!session.actorId) { requireLogin("Silakan masuk."); return; }
        lastActor.current = session.actorId; setActor(session.actorId); await refreshProjects();
        if (!current()) return;
        const selected = new URLSearchParams(window.location.search).get("analysisId");
        if (selected) {
          const loading = load(parseStableId<"analysis">(selected));
          epoch = workspaceEpoch.current;
          await loading;
        }
        if (current()) setMessage("Siap.");
      } catch (cause) {
        if (current()) {
          if (cause instanceof ApiError && cause.code === "SESSION_CHANGED") return;
          if (cause instanceof ApiError && cause.code === "UNAUTHENTICATED") { requireLogin("Silakan masuk kembali."); return; }
          setMessage("");
          setError(cause instanceof Error ? cause.message : "Sesi gagal dimuat.");
        }
      } finally { if (current()) setBusy(false); }
    })();
    return () => { active = false; };
  }, [load, refreshProjects, requireLogin]);
  useEffect(() => {
    const channel = new BroadcastChannel("procurement-session"); sessionChannel.current = channel;
    channel.onmessage = event => {
      if (event.data?.actorId !== lastActor.current) requireLogin("Sesi berubah di tab lain. Silakan masuk kembali.");
    };
    return () => { channel.close(); sessionChannel.current = null; };
  }, [requireLogin]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function edit(s: WorkbookSnapshot, config = s.workbook ? s.workbook.configuration : configurationRef.current) {
    if (snapshotRef.current?.analysisId !== s.analysisId) { workspaceEpoch.current++; savedVersion.current = null; }
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    ({ snapshot: s, configuration: config } = prepareCalculationPolicy(s, config));
    s = prepareVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s))))));
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    s = refreshCurrentOffers(s);
    if (actor) s = prepareSelectedVendorMappings(s, actor);
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    configurationRef.current = config; snapshotRef.current = s; setSnapshot(s); setConfiguration(config); setDirty(true); pendingSave.current = null; setError(""); setMessage("Perubahan belum disimpan.");
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
  function save(): Promise<void> {
    if (saveFlight.current) return saveFlight.current;
    const flight = performSave();
    saveFlight.current = flight;
    void flight.finally(() => { if (saveFlight.current === flight) saveFlight.current = null; }).catch(() => {});
    return flight;
  }
  async function performSave() {
    const formulaInput = document.querySelector<HTMLInputElement>('[data-testid="procurement-sheet"] .formula-bar-form input[data-editing="true"]');
    if (formulaInput) {
      const form = formulaInput.form;
      form?.requestSubmit();
      if (form?.dataset.commitFailed === "true") throw new Error("Perbaiki input sel sebelum menyimpan.");
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.matches('[data-testid="procurement-sheet"] .sheet-input')) active.blur();
    if (document.querySelector('[data-testid="procurement-sheet"] .sheet-input[data-invalid="true"]')) throw new Error("Perbaiki input sel sebelum menyimpan.");
    if (volumeErrorRef.current) throw new Error(volumeErrorRef.current);
    const current = snapshotRef.current;
    if (!current) return;
    const request: SaveRequest = pendingSave.current ?? {
      expectedVersion: savedVersion.current, mutationId: id<"mutation">(), snapshot: current,
      configuration: current.workbook?.configuration ?? configurationRef.current };
    pendingSave.current = request;
    const epoch = workspaceEpoch.current, actorId = lastActor.current;
    const outcome = await api<SaveOutcome>("/api/workbook", { method: "POST", body: saveRequestBody(request) });
    if (outcome.status !== "SAVED") throw new ApiError(outcome.code);
    if (workspaceEpoch.current !== epoch || lastActor.current !== actorId || snapshotRef.current?.analysisId !== current.analysisId) return;
    pendingSave.current = null;
    savedVersion.current = outcome.workbook.version;
    if (snapshotRef.current.id === current.id) { snapshotRef.current = outcome.workbook.snapshot; setSnapshot(outcome.workbook.snapshot); configurationRef.current = outcome.workbook.configuration; setConfiguration(outcome.workbook.configuration); setDirty(false); }
    setProjects(prior => prior.some(project => project.id === current.projectId) ? prior : [...prior, { id: current.projectId, name: current.project.name }]);
    setAnalyses(prior => prior.map(analysis => analysis.id === current.analysisId ? { ...analysis, name: current.analysis.analysis.name } : analysis));
    window.history.replaceState(null, "", "?analysisId=" + current.analysisId);
    setMessage("Tersimpan.");
  }

  return <main className={actor ? "workbook-app" : "login-app"}>
    <header className="app-header">
      <div className="app-brand"><Image src="/image.png" width={38} height={39} alt="" priority />
        <div><h1>Sistem Evaluasi Vendor</h1>{snapshot && <span>{snapshot.project.name}</span>}</div>
      </div>
      {actor && <nav className="app-actions" aria-label="Tindakan workspace">
        {dirty && <span className="unsaved-state">Belum disimpan</span>}
        {snapshot && <button type="button" onClick={showProjectList}>Daftar proyek</button>}
        {snapshot && <button aria-label="Simpan workbook" aria-busy={saving} disabled={busy} onClick={() => void task(() => save(), true)}>{saving ? "Menyimpan…" : "Simpan"}</button>}
        <button disabled={busy} onClick={() => {
          if (dirty && !window.confirm("Keluar akan membuang draft yang belum disimpan. Lanjutkan?")) return;
          void task(async () => { invalidateSessionRequests(); workspaceEpoch.current++; await api("/api/session", { method: "DELETE" }, false); setActor(null); snapshotRef.current = null; setSnapshot(null); setProjects([]); setAnalyses([]); setExpandedProjectId(null);
            sessionChannel.current?.postMessage({ actorId: null }); lastActor.current = null; workspaceEpoch.current++;
            configurationRef.current = null; setConfiguration(null); setDirty(false); pendingSave.current = null; window.history.replaceState(null, "", "/"); setMessage("Berhasil keluar."); });
        }}>Keluar</button>
      </nav>}
    </header>
    <div className="operation-status" role="status" aria-label="Status operasi" aria-live="polite">{busy || preparingPrint ? loadingLabel : message}</div>
    <LoadingIndicator active={busy || preparingPrint} label={loadingLabel} />
    {(error || (snapshot && volumeError) || preview?.error) && <p role="alert">{error || volumeError || `Perhitungan gagal: ${preview?.error}`}</p>}
    {!actor ? <section><h2>Masuk</h2><form onSubmit={event => { const form = submit(event); const element = event.currentTarget;
      const password = element.elements.namedItem("password"); if (password instanceof HTMLInputElement) password.value = "";
      void task(async () => {
        invalidateSessionRequests(); workspaceEpoch.current++;
        const session = await api<{ actorId: StableId<"user"> }>("/api/session", { method: "POST", body: JSON.stringify({ operation: "LOGIN", email: field(form, "email"), password: String(form.get("password")) }) }, false);
        if (lastActor.current !== session.actorId) {
          workspaceEpoch.current++;
          snapshotRef.current = null; configurationRef.current = null; setSnapshot(null); setConfiguration(null); savedVersion.current = null; setDirty(false); pendingSave.current = null;
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
            edit(initializeAnalysisDate(prepareLegacySheet(next)), next.workbook?.configuration ?? null);
            savedVersion.current = null; setNewWorkbookProjectId(null);
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
        configuration={configuration}
        run={preview?.run ?? null}
        disabled={busy}
        saving={saving}
        onPrintLoading={setPreparingPrint}
        volumeError={volumeError}
        actor={actor}
        onChange={next => {
          if (next.workbook) { edit(next); return; }
          const remaining = new Set(next.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))));
          const units = configuration?.units.filter(u => remaining.has(u.cellId));
          edit(next, configuration && units && units.length !== configuration.units.length ? { ...configuration, version: id<"policy">(), units } : configuration);
        }}
        onError={setError}
        onEditing={() => { setDirty(true); pendingSave.current = null; }}
        onSave={() => void task(() => save(), true)}
        onSelectOffer={selectionId => { if (snapshot && actor) mutate(() => {
          edit(selectSheetOffer(snapshot, parseStableId<"offer">(selectionId), actor));
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
