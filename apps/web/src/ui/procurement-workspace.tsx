"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, PointerEvent } from "react";
import Image from "next/image";
import { AlertTriangle, ArrowLeft, Building2, ChevronRight, FileSpreadsheet, LogIn, LogOut, Pencil, Save, Trash2 } from "lucide-react";
import type { WorkbookSnapshot, WorksheetView } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import { updateCellInput } from "../domain/commands.ts";
import { appendField } from "../domain/workflow.ts";
import { analysisDateInput, analysisPeriod, createAnalysisWorkbook } from "../domain/analysis-creation.ts";
import { canonicalJson, captureSnapshot } from "../domain/snapshots.ts";
import type { AnalysisListItem, AnalysisPage, AnalysisMetadata, SaveRequest, SaveOutcome, LoadedWorkbook } from "../application/contracts.ts";
import { FormulaEngine, worksheetRunView } from "../engine/formula-engine.ts";
import type { EngineConfiguration, EngineRun } from "../engine/contracts.ts";
import { api, ApiError, cachedWorkbookList, invalidateSessionRequests, invalidateWorkbookLists, prefetchWorkbookList, readSession, readWorkbookList, saveRequestBody } from "./workbook-client.ts";
import type { ProjectListItem } from "./workbook-client.ts";
import { measureWorkbookTask, recordWorkbookTiming } from "./workbook-performance.ts";
import { ExternalAhsSurface } from "./external-ahs-surface.tsx";
import { createExternalAhs, internalAhsFingerprint, refreshExternalAhs } from "../domain/external-ahs.ts";
import { PROFILES } from "../domain/profiles.ts";
import { WorksheetSurface } from "./worksheet-surface.tsx";
import { LoadingIndicator } from "./loading-indicator.tsx";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import { CardContent, CardDescription, CardFooter, CardHeader } from "../components/ui/card.tsx";
import SignIn from "../components/ui/modern-login-signup.tsx";
import { ExpandingSearchDock } from "../components/ui/expanding-search-dock-shadcnui.tsx";
import { prepareNumericBlanks } from "../domain/procurement-template.ts";
import { prepareLegacySheet, legacyConfiguration, connectAhsHpp, makeAhsSaleInput } from "../domain/legacy-sheet.ts";
import { prepareVendorColumns, prepareSelectedVendorMappings, selectSheetOffer } from "../domain/dynamic-workflow.ts";
import { refreshCurrentOffers } from "../domain/current-offers.ts";
import { connectAhsVolumes } from "../domain/ahs-volume.ts";
import { prepareCalculationPolicy } from "../domain/calculation-policy.ts";
import { prepareAhsRollups } from "../domain/ahs-groups.ts";
import { ANALYSIS_STATUSES, analysisStatusLabel } from "../domain/analysis-status.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";
import { analysisListUrl, matchesName, projectLocationUrl, readProjectLocation } from "./project-navigation.ts";
import type { ProjectLocation } from "./project-navigation.ts";

type Confirmation = { eyebrow: string; title: string; description: string; confirmLabel?: string; cancelLabel?: string; secondaryLabel?: string; onSecondary?: () => void | Promise<void>; onConfirm: () => void | Promise<void> };
type ExternalPreparation = { analysisId: string; epoch: number; actorId: string | null; profile: string;
  resume?: (result: { run: EngineRun | null; error?: string }) => void };
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
  const [draftAnalysisStatus, setDraftAnalysisStatus] = useState<AnalysisStatus | null>(null);
  const [analysisPage, setAnalysisPage] = useState<AnalysisPage>({ items: [], total: 0, periods: [], nextCursor: null, previousCursor: null });
  const [location, setLocation] = useState(() => readProjectLocation(""));
  const locationRef = useRef(location);
  const projectsRef = useRef<ProjectListItem[]>([]);
  const historyIndex = useRef(0);
  const restoringHistory = useRef<(() => void) | null>(null);
  const acceptHistory = useRef(false);
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [dirty, setDirty] = useState(false);
  const [worksheetView, setWorksheetView] = useState<WorksheetView>("INTERNAL");
  const [preparingExternal, setPreparingExternal] = useState(false);
  const [externalNotice, setExternalNotice] = useState("");
  const pendingExternal = useRef<ExternalPreparation | null>(null);
  const cancelExternalPreparation = useCallback(() => {
    const pending = pendingExternal.current;
    pendingExternal.current = null;
    pending?.resume?.({ run: null });
    setPreparingExternal(false);
  }, []);
  const [configuration, setConfiguration] = useState<EngineConfiguration | null>(null);
  const configurationRef = useRef<EngineConfiguration | null>(null);
  const snapshotRef = useRef<WorkbookSnapshot | null>(null);
  const savedSnapshotRef = useRef<WorkbookSnapshot | null>(null);
  const saveActionRef = useRef<(() => Promise<void>) | null>(null);
  const previewRef = useRef<EngineRun | null>(null);
  const calculationErrorRef = useRef<{ snapshotId: string; error: string } | null>(null);
  const [calculatedPreview, setCalculatedPreview] = useState<{ snapshotId: string; run: EngineRun | null; error: string } | null>(null);
  const pendingSave = useRef<SaveRequest | null>(null);
  const lastActor = useRef<StableId<"user"> | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const [newWorkbookProjectId, setNewWorkbookProjectId] = useState<string | null>(null);
  const [newAnalysisDate, setNewAnalysisDate] = useState("");
  const [newDocumentType, setNewDocumentType] = useState("FULL DOC");
  const [analysisToDelete, setAnalysisToDelete] = useState<{ projectId: string; analysis: AnalysisListItem } | null>(null);
  const [analysisToEdit, setAnalysisToEdit] = useState<AnalysisListItem | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<ProjectListItem | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ project: ProjectListItem; x: number; y: number } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const commitWorksheetEdit = useCallback(() => {
    const active = document.activeElement;
    const input = document.querySelector<HTMLInputElement>('[data-testid="procurement-sheet"] .formula-bar-form input');
    const cellEditing = active instanceof HTMLInputElement && active.matches('[data-testid="procurement-sheet"] .sheet-input') && active.value !== active.dataset.raw;
    if (input?.form && (input.dataset.editing === "true" || cellEditing)) {
      input.form.requestSubmit();
      if (input.form.dataset.commitFailed === "true") { setError("Perbaiki input sel sebelum melanjutkan."); return false; }
    }
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    if (document.querySelector('[data-testid="procurement-sheet"] .sheet-input[data-invalid="true"]')) { setError("Perbaiki input sel sebelum melanjutkan."); return false; }
    return true;
  }, []);
  const confirmLeaving = useCallback((action: () => void, withinAnalysis = false) => {
    const epoch = workspaceEpoch.current, actorId = lastActor.current, analysisId = snapshotRef.current?.analysisId;
    const current = () => workspaceEpoch.current === epoch && lastActor.current === actorId && snapshotRef.current?.analysisId === analysisId;
    setConfirmation({ eyebrow: "Perubahan belum disimpan", title: withinAnalysis ? "Kembali ke Internal?" : "Keluar dari analisis?",
      description: withinAnalysis ? "Simpan kedua halaman sebelum pindah, atau lanjutkan dengan draft yang tetap ada di analisis ini." : "Simpan kedua halaman sebelum keluar. Keluar tanpa menyimpan membuang seluruh perubahan sejak penyimpanan terakhir.",
      cancelLabel: "Batal", confirmLabel: withinAnalysis ? "Simpan dan pindah" : "Simpan dan keluar",
      secondaryLabel: withinAnalysis ? "Pindah tanpa menyimpan" : "Keluar tanpa menyimpan",
      onSecondary: () => { if (current()) action(); },
      onConfirm: async () => {
        if (!current()) return;
        if (!saveActionRef.current) throw new Error("Penyimpanan belum siap.");
        setBusy(true); setSaving(true);
        try {
          await saveActionRef.current();
          if (!current()) return;
          if (!snapshotRef.current || !savedSnapshotRef.current || canonicalJson(snapshotRef.current) !== canonicalJson(savedSnapshotRef.current)) throw new Error("Masih ada perubahan belum disimpan. Simpan kembali sebelum keluar.");
        } finally { setBusy(false); setSaving(false); }
        if (current()) action();
      },
    });
  }, []);
  const [volumeError, setVolumeError] = useState("");
  const volumeErrorRef = useRef("");

  const prepareVolumes = useCallback((s: WorkbookSnapshot) => {
    let issue = "";
    try { s = prepareAhsRollups(connectAhsVolumes(s)); }
    catch (cause) { issue = cause instanceof Error ? cause.message : "Volume AHS gagal diselaraskan."; }
    volumeErrorRef.current = issue; setVolumeError(issue);
    return s;
  }, []);

  const saveFlight = useRef<Promise<void> | null>(null);
  const taskSequence = useRef(0);
  const workspaceEpoch = useRef(0);
  const savedVersion = useRef<StableId<"version"> | null>(null);
  const renderTiming = useRef<{ snapshotId: string; started: number; stage: "worksheet-render" | "save-render" } | null>(null);
  const projectLongPressTimer = useRef<number | null>(null);
  const projectPrefetchTimer = useRef<number | null>(null);
  const suppressProjectClick = useRef(false);
  useEffect(() => () => {
    workspaceEpoch.current++;
    pendingExternal.current?.resume?.({ run: null }); pendingExternal.current = null;
    if (projectLongPressTimer.current !== null) window.clearTimeout(projectLongPressTimer.current);
    if (projectPrefetchTimer.current !== null) window.clearTimeout(projectPrefetchTimer.current);
  }, []);

  const requireLogin = useCallback((status: string) => {
    cancelExternalPreparation();
    if (projectPrefetchTimer.current !== null) window.clearTimeout(projectPrefetchTimer.current);
    invalidateSessionRequests(); workspaceEpoch.current++;
    setActor(null); setError(""); setMessage(status); setBusy(false);
  }, [cancelExternalPreparation]);

  const backgroundError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.code === "SESSION_CHANGED") return;
    if (cause instanceof ApiError && cause.code === "UNAUTHENTICATED") { requireLogin("Sesi berakhir. Silakan masuk kembali."); return; }
    setError(cause instanceof Error ? cause.message : "Pembaruan daftar gagal. Data terakhir tetap ditampilkan.");
  }, [requireLogin]);

  const canRestoreWithoutLoading = useCallback((next: ProjectLocation) => {
    const actorId = lastActor.current;
    if (!actorId || next.analysisId) return false;
    const cachedProjects = cachedWorkbookList<ProjectListItem[]>(actorId, "/api/workbook?view=projects");
    return !!cachedProjects && (!next.projectId || (cachedProjects.some(project => project.id === next.projectId) &&
      cachedWorkbookList<AnalysisPage>(actorId, analysisListUrl(next)) !== undefined));
  }, []);

  const writeLocation = useCallback((next: ProjectLocation, mode: "push" | "replace" = "push") => {
    if (mode === "push") historyIndex.current++;
    window.history[mode === "push" ? "pushState" : "replaceState"]({ ...window.history.state, procurementIndex: historyIndex.current }, "", projectLocationUrl(next));
    locationRef.current = next; setLocation(next);
  }, []);

  const clearWorksheet = useCallback(() => {
    cancelExternalPreparation(); setExternalNotice("");
    setDraftAnalysisStatus(null);
    renderTiming.current = null;
    snapshotRef.current = null; savedSnapshotRef.current = null; configurationRef.current = null;
    setSnapshot(null); setWorksheetView("INTERNAL"); savedVersion.current = null; setConfiguration(null); setDirty(false);
    setNewWorkbookProjectId(null); pendingSave.current = null; setVolumeError(""); volumeErrorRef.current = "";
    previewRef.current = null; setCalculatedPreview(null);
  }, [cancelExternalPreparation]);

  const load = useCallback(async (analysisId: string) => {
    cancelExternalPreparation(); setExternalNotice("");
    const started = performance.now();
    try {
      const epoch = ++workspaceEpoch.current, actorId = lastActor.current;
      const stored = await api<LoadedWorkbook | null>(`/api/workbook?analysisId=${analysisId}`);
      if (workspaceEpoch.current !== epoch || lastActor.current !== actorId) return;
      if (!stored) throw new ApiError("NOT_FOUND_OR_FORBIDDEN");
      if (!stored.analysisMetadata || stored.analysisMetadata.id !== analysisId || stored.analysisMetadata.version !== stored.version ||
        !ANALYSIS_STATUSES.includes(stored.analysisMetadata.status)) throw new ApiError("INVALID_REQUEST");
      const { s, config } = measureWorkbookTask("normalize", () => {
        let s = captureSnapshot(stored.snapshot);
        let config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, stored.configuration);
        ({ snapshot: s, configuration: config } = prepareCalculationPolicy(s, config));
        s = prepareVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s))))));
        config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
        s = refreshCurrentOffers(s);
        const mappingActor = lastActor.current;
        if (mappingActor) s = prepareSelectedVendorMappings(s, mappingActor);
        config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
        return { s, config };
      });
      if (workspaceEpoch.current !== epoch || lastActor.current !== actorId) return;
      renderTiming.current = { snapshotId: s.id, started, stage: "worksheet-render" };
      previewRef.current = null; configurationRef.current = config; snapshotRef.current = s; setSnapshot(s);
      setWorksheetView("INTERNAL"); savedVersion.current = stored.version;
      setDraftAnalysisStatus(null);
      setConfiguration(config); savedSnapshotRef.current = s; setDirty(false); pendingSave.current = null;
      setAnalyses([{ ...stored.analysisMetadata, project_id: s.projectId, period: null }]);
      writeLocation({ ...locationRef.current, projectId: s.projectId, analysisId }, "replace");
      setMessage("Analisis dimuat.");
    } finally { recordWorkbookTiming("load", started); }
  }, [cancelExternalPreparation, prepareVolumes, writeLocation]);

  useEffect(() => {
    const pending = renderTiming.current;
    if (!snapshot || pending?.snapshotId !== snapshot.id) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (renderTiming.current !== pending) return;
        recordWorkbookTiming(pending.stage, pending.started);
        renderTiming.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot]);
  const refreshProjects = useCallback(async () => {
    const actorId = lastActor.current;
    if (!actorId) return;
    const { cached, pending } = readWorkbookList<ProjectListItem[]>(actorId, "/api/workbook?view=projects");
    if (cached) { projectsRef.current = cached; setProjects(cached); }
    const next = await pending;
    if (next && lastActor.current === actorId && cachedWorkbookList(actorId, "/api/workbook?view=projects") === next) {
      projectsRef.current = next; setProjects(next);
    }
  }, []);

  const restoreLocation = useCallback(async (next: ProjectLocation) => {
    locationRef.current = next; setLocation(next); setError("");
    setAnalysisToDelete(null); setAnalysisToEdit(null); setProjectToDelete(null); setProjectContextMenu(null); setConfirmation(null);
    if (next.analysisId) {
      if (snapshotRef.current?.analysisId !== next.analysisId) {
        clearWorksheet(); setAnalyses([]);
        await load(parseStableId<"analysis">(next.analysisId));
      }
      return;
    }
    const epoch = ++workspaceEpoch.current, actorId = lastActor.current;
    const current = () => workspaceEpoch.current === epoch && lastActor.current === actorId;
    const fail = (cause: unknown) => { if (current()) backgroundError(cause); };
    clearWorksheet();
    if (!actorId) return;
    const cachedPage = next.projectId ? cachedWorkbookList<AnalysisPage>(actorId, analysisListUrl(next)) : undefined;
    setAnalyses([...(cachedPage?.items ?? [])]);
    if (cachedPage) setAnalysisPage(cachedPage);
    const cachedProjects = cachedWorkbookList<ProjectListItem[]>(actorId, "/api/workbook?view=projects");
    const projects = refreshProjects();
    if (!cachedProjects || (next.projectId && !cachedProjects.some(project => project.id === next.projectId))) await projects;
    else void projects.catch(fail);
    if (!current()) return;
    if (!next.projectId) { setMessage("Daftar proyek."); return; }
    const projectId = parseStableId<"project">(next.projectId);
    if (!projectsRef.current.some(project => project.id === projectId)) throw new Error("Proyek tidak ditemukan atau tidak dapat diakses.");
    const { cached, pending } = readWorkbookList<AnalysisPage>(actorId, analysisListUrl(next));
    const apply = (page: AnalysisPage | undefined) => {
      if (page && current() && cachedWorkbookList(actorId, analysisListUrl(next)) === page) {
        setAnalyses([...page.items]); setAnalysisPage(page);
      }
    };
    apply(cached);
    if (cached) void pending?.then(apply).catch(fail);
    else apply(await pending ?? undefined);
    if (current()) setMessage("Pilih analisis yang akan dibuka.");
  }, [backgroundError, clearWorksheet, load, refreshProjects]);

  function navigate(next: ProjectLocation, discardDraft = false) {
    if (!discardDraft && !commitWorksheetEdit()) return;
    if (dirty && !discardDraft) {
      confirmLeaving(() => navigate(next, true));
      return;
    }
    writeLocation(next);
    cancelProjectPrefetch();
    void task(() => restoreLocation(next), false, !canRestoreWithoutLoading(next));
  }

  function updateFilters(next: Partial<Pick<ProjectLocation, "projectQuery" | "analysisQuery" | "status" | "period">>) {
    const updated = { ...locationRef.current, ...next, after: "", before: "" };
    writeLocation(updated, "replace");
    if (updated.projectId) void task(() => restoreLocation(updated), false, !canRestoreWithoutLoading(updated));
  }
  function showAnalysisForm(projectId: string) {
    setNewAnalysisDate(analysisDateInput());
    setNewDocumentType("FULL DOC");
    setNewWorkbookProjectId(projectId);
    setError("");
  }
  function projectLocation(projectId: string): ProjectLocation {
    return { ...locationRef.current, projectId, analysisId: null, analysisQuery: "", status: "", period: "", after: "", before: "" };
  }
  function showProject(projectId: string) { navigate(projectLocation(projectId)); }
  function cancelProjectPrefetch() {
    if (projectPrefetchTimer.current !== null) window.clearTimeout(projectPrefetchTimer.current);
    projectPrefetchTimer.current = null;
  }
  function prefetchProject(projectId: string) {
    cancelProjectPrefetch();
    if (busy || !actor) return;
    const actorId = actor, epoch = workspaceEpoch.current;
    const next = projectLocation(projectId);
    projectPrefetchTimer.current = window.setTimeout(() => {
      projectPrefetchTimer.current = null;
      if (workspaceEpoch.current !== epoch || lastActor.current !== actorId) return;
      void prefetchWorkbookList(actorId, analysisListUrl(next))?.catch(cause => {
        if (lastActor.current === actorId && cause instanceof ApiError && cause.code === "UNAUTHENTICATED") requireLogin("Sesi berakhir. Silakan masuk kembali.");
      });
    }, 150);
  }
  function openProjectContextMenu(project: ProjectListItem, x: number, y: number) {
    setProjectContextMenu({ project, x: Math.min(x, window.innerWidth - 220), y: Math.min(y, window.innerHeight - 70) });
  }
  function handleProjectPointerDown(project: ProjectListItem, event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "touch") return;
    if (projectLongPressTimer.current !== null) window.clearTimeout(projectLongPressTimer.current);
    projectLongPressTimer.current = window.setTimeout(() => {
      suppressProjectClick.current = true;
      openProjectContextMenu(project, event.clientX, event.clientY);
    }, 550);
  }
  function handleProjectPointerUp() {
    if (projectLongPressTimer.current !== null) window.clearTimeout(projectLongPressTimer.current);
    projectLongPressTimer.current = null;
  }
  function openAnalysis(analysisId: string) {
    navigate({ ...locationRef.current, analysisId });
  }
  function removeAnalysis(projectId: string, analysis: AnalysisListItem) {
    setAnalysisToDelete({ projectId, analysis });
  }
  async function persistAnalysisMetadata(analysis: AnalysisListItem, name: string, status: AnalysisStatus) {
    const epoch = workspaceEpoch.current, actorId = lastActor.current;
    const expectedVersion = snapshotRef.current?.analysisId === analysis.id ? savedVersion.current : analysis.version;
    if (!expectedVersion) return;
    const updated = await api<AnalysisMetadata>("/api/workbook", {
      method: "POST", body: JSON.stringify({
        operation: "UPDATE_ANALYSIS",
        analysisId: analysis.id, name, status, expectedVersion, mutationId: id<"mutation">()
      })
    });
    if (workspaceEpoch.current !== epoch || lastActor.current !== actorId) return;
    invalidateWorkbookLists(analysis.project_id);
    setAnalyses(current => current.map(item => item.id === analysis.id ? { ...item, ...updated } : item));
    if (snapshotRef.current?.analysisId === analysis.id) {
      savedVersion.current = updated.version;
      const rename = (s: WorkbookSnapshot): WorkbookSnapshot => captureSnapshot({ ...s, analysis: { ...s.analysis, analysis: { ...s.analysis.analysis, name: updated.name } } });
      snapshotRef.current = rename(snapshotRef.current);
      setSnapshot(snapshotRef.current);
      if (savedSnapshotRef.current) savedSnapshotRef.current = rename(savedSnapshotRef.current);
    }
    if (!snapshotRef.current) await restoreLocation(locationRef.current);
    setMessage("Analisis diperbarui.");
  }
  function updateAnalysisMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!analysisToEdit) return;
    const form = new FormData(event.currentTarget);
    const analysis = analysisToEdit;
    const name = field(form, "analysisName");
    const status = field(form, "analysisStatus") as AnalysisStatus;
    setAnalysisToEdit(null);
    void task(() => persistAnalysisMetadata(analysis, name, status));
  }
  function updateActiveAnalysisStatus(status: AnalysisStatus) {
    if (savedVersion.current === null) {
      setDraftAnalysisStatus(status); setDirty(true); return;
    }
    const analysis = snapshot && analyses.find(item => item.id === snapshot.analysisId);
    if (!analysis) return;
    void task(async () => { await persistAnalysisMetadata(analysis, analysis.name, status); setDraftAnalysisStatus(null); });
  }
  function confirmRemoveAnalysis() {
    if (!analysisToDelete) return;
    const { projectId, analysis } = analysisToDelete;
    setAnalysisToDelete(null);
    void task(async () => {
      await api("/api/workbook", { method: "DELETE", body: JSON.stringify({ operation: "DELETE_ANALYSIS", analysisId: analysis.id }) });
      invalidateWorkbookLists(projectId);
      setAnalyses(current => current.filter(item => item.id !== analysis.id));
      setMessage("Analisis dihapus.");
      const epoch = workspaceEpoch.current;
      const actorId = lastActor.current;
      if (!actorId) return;
      const page = await readWorkbookList<AnalysisPage>(actorId, analysisListUrl(locationRef.current)).pending;
      if (page && workspaceEpoch.current === epoch && lastActor.current === actorId && locationRef.current.projectId === projectId) {
        setAnalyses([...page.items]); setAnalysisPage(page);
        if (!page.items.length && (locationRef.current.after || locationRef.current.before)) {
          const first = { ...locationRef.current, after: "", before: "" };
          writeLocation(first, "replace"); await restoreLocation(first);
        }
      }
    });
  }
  function confirmRemoveProject() {
    if (!projectToDelete) return;
    const project = projectToDelete;
    setProjectToDelete(null);
    void task(async () => {
      await api("/api/workbook", { method: "DELETE", body: JSON.stringify({ operation: "DELETE_PROJECT", projectId: project.id }) });
      invalidateWorkbookLists(project.id, true);
      projectsRef.current = projectsRef.current.filter(item => item.id !== project.id); setProjects(projectsRef.current);
      if (locationRef.current.projectId === project.id) {
        clearWorksheet(); setAnalyses([]);
        writeLocation({ ...locationRef.current, projectId: null, analysisId: null }, "replace");
      }
      setMessage("Proyek dihapus.");
    });
  }
  function showProjectList() {
    navigate({ ...locationRef.current, projectId: null, analysisId: null });
  }
  function returnToProject() {
    const projectId = snapshotRef.current?.projectId;
    navigate({ ...locationRef.current, projectId: projectId && projectsRef.current.some(project => project.id === projectId) ? projectId : null, analysisId: null });
  }
  function logout(discardDraft = false) {
    if (!discardDraft && !commitWorksheetEdit()) return;
    if (dirty && !discardDraft) {
      confirmLeaving(() => logout(true));
      return;
    }
    void task(async () => {
      invalidateSessionRequests(); workspaceEpoch.current++; await api("/api/session", { method: "DELETE" }, false); setActor(null); clearWorksheet(); setProjects([]); projectsRef.current = []; setAnalyses([]);
      sessionChannel.current?.postMessage({ actorId: null }); lastActor.current = null; workspaceEpoch.current++;
      writeLocation(readProjectLocation(""), "replace"); setMessage("Berhasil keluar.");
    });
  }
  const task = useCallback(async (action: () => void | Promise<void>, isSave = false, blocking = true) => {
    const sequence = ++taskSequence.current;
    setBusy(blocking); setSaving(isSave); setError(""); setMessage("Memproses…");
    try { await action(); }
    catch (cause) {
      if (sequence !== taskSequence.current) return;
      if (cause instanceof ApiError && cause.code === "SESSION_CHANGED") return;
      if (cause instanceof ApiError && cause.code === "UNAUTHENTICATED") {
        requireLogin("Sesi berakhir. Silakan masuk kembali."); return;
      }
      setError(cause instanceof Error ? cause.message : "Operasi gagal."); setMessage("");
    } finally { if (sequence === taskSequence.current) { setBusy(false); setSaving(false); } }
  }, [requireLogin]);
  useEffect(() => {
    let active = true, epoch = workspaceEpoch.current;
    const current = () => active && workspaceEpoch.current === epoch;
    historyIndex.current = window.history.state?.procurementIndex ?? 0;
    window.history.replaceState({ ...window.history.state, procurementIndex: historyIndex.current }, "", window.location.href);
    void (async () => {
      try {
        const session = await readSession();
        if (!current()) return;
        if (!session.actorId) { requireLogin("Silakan masuk."); return; }
        lastActor.current = session.actorId; setActor(session.actorId); await refreshProjects();
        if (!current()) return;
        const loading = restoreLocation(readProjectLocation(window.location.search));
        epoch = workspaceEpoch.current;
        await loading;
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
  }, [restoreLocation, refreshProjects, requireLogin]);
  useEffect(() => {
    if (!actor) return;
    const onPopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        const afterRestore = restoringHistory.current; restoringHistory.current = null;
        afterRestore(); return;
      }
      const next = readProjectLocation(window.location.search);
      const targetIndex = typeof event.state?.procurementIndex === "number" ? event.state.procurementIndex : historyIndex.current - 1;
      const delta = historyIndex.current - targetIndex;
      const leavingDraft = dirty && snapshotRef.current && next.analysisId !== snapshotRef.current.analysisId;
      if (leavingDraft && !acceptHistory.current && delta) {
        // Restore the actual history position before asking, so Cancel preserves Forward/Back.
        restoringHistory.current = () => { if (commitWorksheetEdit()) confirmLeaving(() => { acceptHistory.current = true; window.history.go(-delta); }); };
        window.history.go(delta); return;
      }
      acceptHistory.current = false; historyIndex.current = targetIndex;
      void task(() => restoreLocation(next), false, !canRestoreWithoutLoading(next));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [actor, canRestoreWithoutLoading, commitWorksheetEdit, confirmLeaving, dirty, restoreLocation, task]);
  useEffect(() => {
    if (!actor) return;
    const refresh = () => {
      if (busy || document.visibilityState !== "visible" || snapshotRef.current) return;
      const next = locationRef.current, epoch = workspaceEpoch.current;
      const current = () => workspaceEpoch.current === epoch && lastActor.current === actor && !snapshotRef.current;
      const fail = (cause: unknown) => { if (current()) backgroundError(cause); };
      void refreshProjects().catch(fail);
      if (next.projectId) {
        const { pending } = readWorkbookList<AnalysisPage>(actor, analysisListUrl(next));
        void pending?.then(page => {
          if (page && current() && cachedWorkbookList(actor, analysisListUrl(next)) === page) {
            setAnalyses([...page.items]); setAnalysisPage(page);
          }
        }).catch(fail);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [actor, backgroundError, busy, refreshProjects]);
  useEffect(() => {
    const channel = new BroadcastChannel("procurement-session"); sessionChannel.current = channel;
    channel.onmessage = event => {
      if (event.data?.actorId !== lastActor.current) requireLogin("Sesi berubah di tab lain. Silakan masuk kembali.");
    };
    return () => { channel.close(); sessionChannel.current = null; };
  }, [requireLogin]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  function edit(s: WorkbookSnapshot, config = s.workbook ? s.workbook.configuration : configurationRef.current) {
    if (snapshotRef.current?.analysisId !== s.analysisId) { cancelExternalPreparation(); setExternalNotice(""); workspaceEpoch.current++; savedVersion.current = null; setWorksheetView("INTERNAL"); }
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    ({ snapshot: s, configuration: config } = prepareCalculationPolicy(s, config));
    s = prepareVolumes(prepareNumericBlanks(makeAhsSaleInput(connectAhsHpp(prepareLegacySheet(prepareVendorColumns(s))))));
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    s = refreshCurrentOffers(s);
    if (actor) s = prepareSelectedVendorMappings(s, actor);
    config = s.workbook ? s.workbook.configuration : legacyConfiguration(s, config);
    configurationRef.current = config; snapshotRef.current = s; setSnapshot(s); setConfiguration(config);
    setDirty(!savedSnapshotRef.current || canonicalJson(s) !== canonicalJson(savedSnapshotRef.current));
    pendingSave.current = null; setError(""); setMessage("Perubahan belum disimpan.");
  }
  function mutate(action: () => void) { try { action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Input tidak valid."); } }
  useEffect(() => {
    if (!snapshot || !configuration) return;
    let active = true;
    const timer = window.setTimeout(() => {
      try {
        const run = measureWorkbookTask("calculation", () => {
          const engine = new FormulaEngine(configuration);
          const previous = previewRef.current;
          return previous && previous.manifest.snapshot.analysisId === snapshot.analysisId &&
            previous.manifest.snapshot.activeProfile === snapshot.activeProfile
            ? engine.recalculate(snapshot, previous) : engine.evaluate(snapshot);
        });
        if (active) {
          calculationErrorRef.current = null; previewRef.current = run; setCalculatedPreview({ snapshotId: snapshot.id, run, error: "" });
          pendingExternal.current?.resume?.({ run });
        }
      } catch (cause) {
        if (active) {
          const error = cause instanceof Error ? cause.message : "Konfigurasi tidak valid.";
          calculationErrorRef.current = { snapshotId: snapshot.id, error };
          setCalculatedPreview({ snapshotId: snapshot.id, run: null, error });
          pendingExternal.current?.resume?.({ run: null, error });
        }
      }
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [snapshot, configuration]);
  const preview = useMemo(() => calculatedPreview && calculatedPreview.snapshotId === snapshot?.id
    ? { ...calculatedPreview, run: calculatedPreview.run ? worksheetRunView(calculatedPreview.run, worksheetView) : null } : null,
  [calculatedPreview, snapshot?.id, worksheetView]);
  async function switchWorksheetView(view: WorksheetView, options: { replace?: boolean; skipExit?: boolean } = {}) {
    if (busy) return;
    if (view === "INTERNAL") cancelExternalPreparation();
    else if (pendingExternal.current) return;
    if (!commitWorksheetEdit()) return;
    if (view === "INTERNAL" && worksheetView === "EXTERNAL" && dirty && !options.skipExit) {
      confirmLeaving(() => { void switchWorksheetView("INTERNAL", { skipExit: true }); }, true); return;
    }
    if (view === "INTERNAL") {
      startTransition(() => setWorksheetView(view)); return;
    }
    let current = snapshotRef.current;
    if (!current || !configurationRef.current) return;
    const request: ExternalPreparation = { analysisId: current.analysisId, epoch: workspaceEpoch.current, actorId: lastActor.current, profile: current.activeProfile };
    const valid = () => workspaceEpoch.current === request.epoch && lastActor.current === request.actorId &&
      snapshotRef.current?.analysisId === request.analysisId && snapshotRef.current.activeProfile === request.profile;
    pendingExternal.current = request; setPreparingExternal(true); setError("");
    try {
      for (;;) {
        let run = previewRef.current;
        while (run?.snapshotId !== current.id) {
          if (calculationErrorRef.current?.snapshotId === current.id) throw new Error(calculationErrorRef.current.error);
          if (calculatedPreview?.snapshotId === current.id && calculatedPreview.error) throw new Error(calculatedPreview.error);
          const result = await new Promise<{ run: EngineRun | null; error?: string }>(resolve => { request.resume = resolve; });
          if (pendingExternal.current !== request || !valid()) return;
          if (result.error) throw new Error(result.error);
          if (!result.run) return;
          current = snapshotRef.current!; run = result.run;
        }
        if (pendingExternal.current !== request || !valid() || !configurationRef.current) return;
        const config: EngineConfiguration = configurationRef.current;
        const hasExternal = current.worksheets.some(w => w.stage === "AHS_EXTERNAL");
        const profiles = hasExternal ? [current.activeProfile] : PROFILES;
        const fingerprints = Object.fromEntries(await Promise.all(profiles.map(async profile => [profile, await internalAhsFingerprint(current!, config, run, profile)])));
        if (pendingExternal.current !== request || !valid()) return;
        if (snapshotRef.current!.id !== current.id || configurationRef.current !== config) { current = snapshotRef.current!; continue; }
        const fingerprint = fingerprints[current.activeProfile]!;
        if (hasExternal && !options.replace) {
          if (current.externalAhs?.sourceFingerprints?.[current.activeProfile] !== fingerprint) {
            setConfirmation({ eyebrow: "AHS Eksternal", title: "Gunakan data Internal terbaru untuk profil ini?",
              description: `Perbarui seluruh AHS Eksternal ${current.activeProfile === "INU" ? "INU" : "SKP"} dari Internal terbaru. Nilai, rumus, catatan, kelompok, dan uraian tambahan Eksternal pada profil ini akan diganti. Profil lain tetap dipertahankan.`,
              confirmLabel: "Perbarui Eksternal", secondaryLabel: "Tetap pakai Eksternal", cancelLabel: "Batal",
              onConfirm: async () => { if (valid()) await switchWorksheetView("EXTERNAL", { replace: true }); },
              onSecondary: () => { if (valid()) startTransition(() => setWorksheetView("EXTERNAL")); },
            });
          } else startTransition(() => setWorksheetView("EXTERNAL"));
          return;
        }
        const copied = hasExternal ? refreshExternalAhs(current, config, run, fingerprint) : createExternalAhs(current, config, run, fingerprints);
        edit(copied.snapshot, copied.configuration);
        setExternalNotice(copied.incomplete ? `${copied.incomplete} nilai sumber Internal belum tersedia; sel Eksternal tersebut dibiarkan kosong.` : "");
        setMessage(`AHS Eksternal ${hasExternal ? "diperbarui" : "dibuat"} dari draft Internal. Perubahan belum disimpan.`);
        startTransition(() => setWorksheetView("EXTERNAL")); return;
      }
    } catch (cause) {
      if (pendingExternal.current === request && workspaceEpoch.current === request.epoch && lastActor.current === request.actorId) {
        setError(cause instanceof Error ? cause.message : "AHS Eksternal gagal disiapkan. Klik Eksternal untuk mencoba lagi.");
      }
    } finally {
      if (pendingExternal.current === request) { pendingExternal.current = null; setPreparingExternal(false); }
    }
  }
  function save(): Promise<void> {
    if (saveFlight.current) return saveFlight.current;
    if (pendingExternal.current) return Promise.reject(new Error("Tunggu penyiapan Eksternal selesai sebelum menyimpan."));
    const flight = performSave();
    saveFlight.current = flight;
    void flight.finally(() => { if (saveFlight.current === flight) saveFlight.current = null; }).catch(() => { });
    return flight;
  }
  useEffect(() => { saveActionRef.current = save; });
  async function performSave() {
    const started = performance.now();
    try {
      const current = measureWorkbookTask("save-input", () => {
        const analysis = analyses.find(item => item.id === snapshotRef.current?.analysisId);
        if ((!analysis && savedVersion.current !== null) || (analysis && !ANALYSIS_STATUSES.includes(analysis.status))) {
          throw new Error("Status analisis wajib dipilih dan harus valid sebelum data dapat disimpan.");
        }
        if (!commitWorksheetEdit()) throw new Error("Perbaiki input sel sebelum menyimpan.");
        if (volumeErrorRef.current) throw new Error(volumeErrorRef.current);
        return snapshotRef.current;
      });
      if (!current) return;
      const request: SaveRequest = pendingSave.current ?? {
        expectedVersion: savedVersion.current, mutationId: id<"mutation">(), snapshot: current,
        configuration: current.workbook?.configuration ?? configurationRef.current
      };
      pendingSave.current = request;
      const epoch = workspaceEpoch.current, actorId = lastActor.current;
      const body = measureWorkbookTask("save-serialize", () => saveRequestBody(request));
      const requestStarted = performance.now();
      let outcome: SaveOutcome;
      try { outcome = await api<SaveOutcome>("/api/workbook", { method: "POST", body }); }
      finally { recordWorkbookTiming("save-request", requestStarted); }
      if (outcome.status !== "SAVED") throw new ApiError(outcome.code);
      if (workspaceEpoch.current !== epoch || lastActor.current !== actorId || snapshotRef.current?.analysisId !== current.analysisId) return;
      invalidateWorkbookLists(current.projectId, !projectsRef.current.some(project => project.id === current.projectId));
      measureWorkbookTask("save-response", () => {
        pendingSave.current = null;
        savedVersion.current = outcome.workbook.version;
        savedSnapshotRef.current = outcome.workbook.snapshot;
        if (snapshotRef.current?.id === current.id) {
          renderTiming.current = { snapshotId: outcome.workbook.snapshot.id, started, stage: "save-render" };
          snapshotRef.current = outcome.workbook.snapshot; setSnapshot(outcome.workbook.snapshot);
          configurationRef.current = outcome.workbook.configuration; setConfiguration(outcome.workbook.configuration); setDirty(false);
        }
        if (!projectsRef.current.some(project => project.id === current.projectId)) projectsRef.current = [...projectsRef.current, { id: current.projectId, name: current.project.name }];
        setProjects(projectsRef.current);
        setAnalyses(prior => prior.some(analysis => analysis.id === current.analysisId)
          ? prior.map(analysis => analysis.id === current.analysisId ? { ...analysis, name: outcome.workbook.snapshot.analysis.analysis.name, version: outcome.workbook.version } : analysis)
          : [...prior, { id: current.analysisId, name: outcome.workbook.snapshot.analysis.analysis.name, project_id: current.projectId, status: "DRAFT", version: outcome.workbook.version, period: analysisPeriod(newAnalysisDate) || null }]);
        writeLocation({ ...locationRef.current, projectId: current.projectId, analysisId: current.analysisId }, "replace");
        setMessage(request.expectedVersion === outcome.workbook.version ? "Tidak ada perubahan." : "Tersimpan.");
      });
      if (draftAnalysisStatus !== null) {
        try {
          await persistAnalysisMetadata({ id: current.analysisId, name: current.analysis.analysis.name, project_id: current.projectId, status: "DRAFT", version: outcome.workbook.version, period: analysisPeriod(newAnalysisDate) || null }, current.analysis.analysis.name, draftAnalysisStatus);
          if (workspaceEpoch.current === epoch && lastActor.current === actorId) setDraftAnalysisStatus(null);
        } catch (cause) {
          if (workspaceEpoch.current === epoch && lastActor.current === actorId) setDirty(true);
          throw cause;
        }
      }
    } finally { recordWorkbookTiming("save", started); }
  }

  const selectedProject = projects.find(project => project.id === location.projectId);
  const visibleProjects = projects.filter(project => matchesName(project.name, location.projectQuery));
  const visibleAnalyses = analyses.map((analysis, index) => ({ ...analysis, number: index + 1 }));
  const periods = [...analysisPage.periods];
  if (location.period && location.period !== "NONE" && !periods.includes(location.period)) periods.push(location.period);
  const hasFilters = location.projectId ? Boolean(location.analysisQuery || location.status || location.period) : Boolean(location.projectQuery);
  const documentExamples: Record<string, { project: string; analysis: string }> = {
    "FULL DOC": { project: "Proyek Pengadaan HSD - Full Doc", analysis: "Analisis Vendor - Full Doc" },
    PPN: { project: "Proyek Pengadaan HSD - PPN", analysis: "Analisis Vendor - PPN" },
    "NON PPN": { project: "Proyek Pengadaan HSD - Non PPN", analysis: "Analisis Vendor - Non PPN" },
  };
  const selectedDocumentExample = documentExamples[newDocumentType] ?? documentExamples["FULL DOC"]!;
  return <main className={actor ? "workbook-app" : "login-app"}>
    <header className="app-header" hidden={!actor}>
      <div className="app-brand"><Image src="/image.png" width={38} height={39} alt="" priority />
        <div><h1>Sistem Evaluasi Vendor</h1>{(snapshot || selectedProject) && <span>{snapshot?.project.name ?? selectedProject?.name}</span>}</div>
      </div>
      {actor && <nav className="app-actions" aria-label="Tindakan workspace">
        {dirty && <span className="unsaved-state">Belum disimpan</span>}
        {snapshot && <button type="button" aria-label="Kembali ke proyek" title="Kembali ke proyek" disabled={busy} onClick={returnToProject}><ArrowLeft aria-hidden="true" /></button>}
        {snapshot && <button type="button" aria-label={saving ? "Menyimpan workbook" : "Simpan workbook"} title={saving ? "Menyimpan…" : "Simpan"} aria-busy={saving} disabled={busy || preparingExternal} onClick={() => void task(() => save(), true)}><Save aria-hidden="true" /></button>}
        <button type="button" aria-label="Keluar" title="Keluar" disabled={busy} onClick={() => logout()}><LogOut aria-hidden="true" /></button>
      </nav>}
    </header>
    <div className="operation-status" role="status" aria-label="Status operasi" aria-live="polite">{busy || preparingPrint ? loadingLabel : message}</div>
    <LoadingIndicator active={busy || preparingPrint} label={loadingLabel} />
    {actor && (error || (snapshot && volumeError) || preview?.error) && <p role="alert">{error || volumeError || `Perhitungan gagal: ${preview?.error}`}</p>}
    {!actor ? <SignIn busy={busy} error={error} onSubmit={event => {
      const form = submit(event); const element = event.currentTarget;
      const password = element.elements.namedItem("password"); if (password instanceof HTMLInputElement) password.value = "";
      void task(async () => {
        invalidateSessionRequests(); workspaceEpoch.current++;
        const session = await api<{ actorId: StableId<"user"> }>("/api/session", { method: "POST", body: JSON.stringify({ operation: "LOGIN", email: field(form, "email"), password: String(form.get("password")) }) }, false);
        if (lastActor.current !== session.actorId) {
          workspaceEpoch.current++;
          snapshotRef.current = null; savedSnapshotRef.current = null; configurationRef.current = null; setSnapshot(null); setConfiguration(null); savedVersion.current = null; setDirty(false); pendingSave.current = null;
          setProjects([]); projectsRef.current = []; setAnalyses([]); writeLocation(readProjectLocation(""), "replace");
        }
        lastActor.current = session.actorId; setActor(session.actorId); sessionChannel.current?.postMessage({ actorId: session.actorId });
        element.reset(); await refreshProjects(); setMessage("Berhasil masuk.");
      });
    }} />
      : <>
        {snapshot && <nav className="worksheet-view-tabs" aria-label="Halaman analisis">
          <div className="worksheet-view-switcher" data-view={worksheetView}>
            {(["INTERNAL", "EXTERNAL"] as const).map(view => <button type="button" key={view} aria-pressed={worksheetView === view} aria-busy={view === "EXTERNAL" && preparingExternal} disabled={busy || (view === "EXTERNAL" && preparingExternal)} onMouseDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => void switchWorksheetView(view)}>
              {view === "INTERNAL" ? <Building2 aria-hidden="true" /> : <FileSpreadsheet aria-hidden="true" />}
              {view === "INTERNAL" ? "Internal" : preparingExternal ? "Menyiapkan…" : "Eksternal"}
            </button>)}
          </div>
        </nav>}
        {!snapshot ? <section className="project-index" aria-labelledby="project-index-title">
          <header className="project-index-heading">
            <div>
              {location.projectId && <button type="button" className="project-back" disabled={busy} onClick={showProjectList}><ArrowLeft aria-hidden="true" /> Semua proyek</button>}
              <p className="eyebrow">{location.projectId ? "DAFTAR ANALISIS" : "DAFTAR PEKERJAAN"}</p>
              <h2 id="project-index-title">{location.projectId ? selectedProject?.name ?? "Proyek tidak tersedia" : "Proyek berjalan"}</h2>
              <p>{location.projectId ? "Pilih analisis untuk membuka lembar perhitungan." : "Pilih proyek untuk melihat daftar analisis."}</p>
            </div>
            {(!location.projectId || selectedProject) && <button type="button" disabled={busy} onClick={() => showAnalysisForm(selectedProject?.id ?? "")}>{selectedProject ? "＋ Tambah analisis" : "＋ Proyek baru"}</button>}
          </header>
          {(!location.projectId || selectedProject) && <div className="project-filters" role="search" aria-label={location.projectId ? "Filter analisis" : "Cari proyek"}>
            <ExpandingSearchDock key={location.projectId ?? "projects"} label={location.projectId ? "Cari analisis" : "Cari proyek"} placeholder={location.projectId ? "Cari analisis…" : "Cari proyek…"} value={location.projectId ? location.analysisQuery : location.projectQuery} disabled={busy} onSearch={query => updateFilters(location.projectId ? { analysisQuery: query } : { projectQuery: query })} />
            {location.projectId && <>
              <select aria-label="Filter status analisis" value={location.status} disabled={busy} onChange={event => updateFilters({ status: event.target.value as AnalysisStatus | "" })}><option value="">Semua status</option>{ANALYSIS_STATUSES.map(status => <option key={status} value={status}>{analysisStatusLabel[status]}</option>)}</select>
              <select aria-label="Filter periode analisis" value={location.period} disabled={busy} onChange={event => updateFilters({ period: event.target.value })}><option value="">Semua periode</option>{periods.map(period => <option key={period} value={period}>{period}</option>)}<option value="NONE">Tanpa periode</option></select>
            </>}
            {hasFilters && <button type="button" disabled={busy} onClick={() => updateFilters(location.projectId ? { analysisQuery: "", status: "", period: "" } : { projectQuery: "" })}>Reset filter</button>}
            <span className="project-result-count" aria-live="polite">{location.projectId ? `${visibleAnalyses.length} dari ${analysisPage.total} analisis` : `${visibleProjects.length} dari ${projects.length} proyek`}</span>
          </div>}
          {newWorkbookProjectId !== null && <form key={newWorkbookProjectId} id="project-create-form" className="project-create-form" onSubmit={event => {
            const form = submit(event);
            mutate(() => {
              const existing = projects.find(p => p.id === newWorkbookProjectId);
              if (newWorkbookProjectId && !existing) throw new Error("Proyek yang dipilih tidak ditemukan. Silakan pilih proyek kembali.");
              const projectId = existing ? parseStableId<"project">(existing.id) : undefined;
              const projectName = existing?.name ?? field(form, "projectName");
              const next = createAnalysisWorkbook({
                ...(projectId ? { projectId } : {}), projectName,
                analysisName: field(form, "analysisName"), material: field(form, "material"), customer: field(form, "customer"), location: field(form, "location"),
                analysisDate: field(form, "analysisDate"), marketing: field(form, "marketing"), payment: field(form, "payment"),
                economicPrice: field(form, "economicPrice"), source: field(form, "source"), document: field(form, "document"),
                volume: field(form, "volume"),
              });
              edit(next, null);
              setDraftAnalysisStatus(null);
              savedVersion.current = null; setNewWorkbookProjectId(null);
              writeLocation({ ...locationRef.current, projectId: existing?.id ?? null, analysisId: null });
            });
          }}>
            <CardHeader className="project-create-heading">
              <div><p className="form-eyebrow">RUANG KERJA BARU</p><h3>{newWorkbookProjectId ? "Tambah analisis" : "Proyek baru"}</h3></div>
              <button type="button" className="project-create-close" aria-label="Tutup form" disabled={busy} onClick={() => setNewWorkbookProjectId(null)}>×</button>
            </CardHeader>
            <CardDescription className="project-create-intro">Isi identitas analisis untuk menyiapkan header worksheet. Tanda * wajib diisi.</CardDescription>
            {newWorkbookProjectId && <div className="form-project-context"><span>Proyek</span><strong>{projects.find(p => p.id === newWorkbookProjectId)?.name}</strong></div>}
            <CardContent className="project-create-columns">
              <fieldset className="project-create-fields" disabled={busy}>
                <legend className="sr-only">Identitas analisis</legend>
                <div className="project-create-section-heading" aria-hidden="true">Identitas analisis</div>
                {!newWorkbookProjectId && <label className="project-create-wide"><span>Nama proyek *</span><input name="projectName" placeholder={selectedDocumentExample.project} required /></label>}
                <label className="project-create-wide"><span>Nama analisis *</span><input name="analysisName" placeholder={selectedDocumentExample.analysis} required /></label>
                <label><span>Tanggal analisis *</span><input name="analysisDate" type="date" value={newAnalysisDate} onChange={event => setNewAnalysisDate(event.target.value)} required /></label>
                <label><span>Periode</span><input value={analysisPeriod(newAnalysisDate)} readOnly aria-describedby="analysis-period-help" />
                  <small id="analysis-period-help" className="field-help">P1: tanggal 1–14 · P2: tanggal 15–akhir bulan.</small></label>
                <label className="project-create-wide"><span>Pekerjaan / Material *</span><input name="material" placeholder="HSD" required /></label>
                <label><span>Customer *</span><input name="customer" placeholder="Nama customer" required /></label>
                <label><span>Lokasi *</span><input name="location" placeholder="Lokasi pekerjaan" required /></label>
              </fieldset>
              <fieldset className="project-create-fields" disabled={busy}>
                <legend className="sr-only">Informasi AHS</legend>
                <div className="project-create-section-heading" aria-hidden="true">Informasi AHS</div>
                <label className="project-create-wide"><span>Volume (L) *</span><input name="volume" type="text" inputMode="decimal" placeholder="50.000" required /></label>
                <label><span>Marketing *</span><input name="marketing" placeholder="Nama marketing" required /></label>
                <label><span>Pembayaran *</span><input name="payment" placeholder="30 hari" required /></label>
                <label><span>Harga Keekonomian</span><input name="economicPrice" placeholder="Isi jika tersedia" /></label>
                <label><span>Dokumen *</span><select name="document" value={newDocumentType} onChange={event => setNewDocumentType(event.target.value)} aria-label="Dokumen" required><option value="FULL DOC">Full Doc</option><option value="PPN">PPN</option><option value="NON PPN">Non PPN</option></select></label>
              </fieldset>
            </CardContent>
            <CardFooter className="project-create-actions">
              <button type="submit" className="project-create-secondary" value="empty" disabled={busy}>Buat workbook</button>
              <button type="button" className="project-create-cancel" disabled={busy} onClick={() => setNewWorkbookProjectId(null)}>Batal</button>
            </CardFooter>
          </form>}
          {location.projectId ? selectedProject ? <div className="project-analysis-list" aria-label={`Lembar perhitungan ${selectedProject.name}`}>
            {visibleAnalyses.length ? visibleAnalyses.map(analysis => <div className="analysis-row" key={analysis.id}>
              <span className="analysis-number" aria-label={`Nomor analisis ${analysis.number}`}>{String(analysis.number).padStart(2, "0")}</span>
              <div className="analysis-summary">
                <button type="button" className="analysis-name analysis-name-link" aria-label={`Masuk ke ${analysis.name}`} disabled={busy} onClick={() => openAnalysis(analysis.id)}>{analysis.name}</button>
                <span className="analysis-meta"><span className="analysis-period" aria-label={`Periode ${analysis.period ?? "belum tersedia"}`}>{analysis.period ?? "Tanpa periode"}</span><span className={`analysis-status analysis-status-${analysis.status.toLowerCase()}`}>{analysisStatusLabel[analysis.status]}</span></span>
              </div>
              <span className="analysis-actions">
                <button type="button" className="analysis-enter" aria-label={`Masuk ke ${analysis.name}`} title="Masuk" disabled={busy} onClick={() => openAnalysis(analysis.id)}><LogIn aria-hidden="true" /></button>
                <button type="button" className="analysis-edit" aria-label={`Edit ${analysis.name}`} title="Edit analisis" disabled={busy} onClick={() => setAnalysisToEdit(analysis)}><Pencil aria-hidden="true" /></button>
                <button type="button" className="analysis-delete" aria-label={`Hapus ${analysis.name}`} title="Hapus" disabled={busy} onClick={() => removeAnalysis(selectedProject.id, analysis)}><Trash2 aria-hidden="true" /></button>
              </span>
            </div>) : <div className="project-empty"><p>{hasFilters ? "Tidak ada analisis yang sesuai filter." : "Belum ada analisis pada halaman ini."}</p></div>}
            {analysisPage.total > 25 && <nav className="analysis-pagination" aria-label="Halaman analisis">
              <span className="analysis-pagination-label">Menampilkan {visibleAnalyses.length} dari {analysisPage.total}</span>
              <div className="analysis-pagination-actions">
                <button type="button" className="analysis-pagination-secondary" disabled={busy || !analysisPage.previousCursor} onClick={() => navigate({ ...locationRef.current, after: "", before: analysisPage.previousCursor! })}>Sebelumnya</button>
                <button type="button" className="analysis-pagination-primary" disabled={busy || !analysisPage.nextCursor} onClick={() => navigate({ ...locationRef.current, before: "", after: analysisPage.nextCursor! })}>Berikutnya</button>
                {!analyses.length && (location.after || location.before) && <button type="button" className="analysis-pagination-secondary" disabled={busy} onClick={() => navigate({ ...locationRef.current, after: "", before: "" })}>Halaman pertama</button>}
              </div>
            </nav>}
          </div> : <div className="project-empty"><p>Proyek tidak ditemukan atau tidak dapat diakses.</p><button type="button" disabled={busy} onClick={showProjectList}>Kembali ke daftar proyek</button></div>
            : visibleProjects.length ? <ol className="project-list">
              {visibleProjects.map((project, index) => {
                return <li key={project.id} className="project-row">
                  <div className="project-row-header">
                    <button type="button" className="project-row-button" disabled={busy}
                      onPointerEnter={event => { if (event.pointerType === "mouse") prefetchProject(project.id); }}
                      onPointerLeave={cancelProjectPrefetch}
                      onFocus={() => prefetchProject(project.id)}
                      onBlur={cancelProjectPrefetch}
                      onClick={() => {
                        if (suppressProjectClick.current) { suppressProjectClick.current = false; return; }
                        showProject(project.id);
                      }}
                      onContextMenu={event => { event.preventDefault(); openProjectContextMenu(project, event.clientX, event.clientY); }}
                      onPointerDown={event => handleProjectPointerDown(project, event)}
                      onPointerUp={handleProjectPointerUp}
                      onPointerCancel={handleProjectPointerUp}>
                      <span className="project-number">{String(index + 1).padStart(2, "0")}</span>
                      <span className="project-name">{project.name}</span>
                      <span className="project-action" aria-hidden="true"><ChevronRight /></span>
                    </button>
                  </div>
                </li>;
              })}
            </ol> : <div className="project-empty"><p>{projects.length ? "Tidak ada proyek yang sesuai pencarian." : "Belum ada proyek tersimpan."}</p>{!projects.length && <button type="button" disabled={busy} onClick={() => showAnalysisForm("")}>Buat proyek pertama</button>}</div>}
        </section> : worksheetView === "EXTERNAL" && configuration ? <ExternalAhsSurface key={snapshot.analysisId + snapshot.activeProfile} snapshot={snapshot} configuration={configuration} run={preview?.run ?? null} notice={externalNotice} disabled={busy} saving={saving} calculating={!preview} onChange={(next, config) => edit(next, config ?? (next.workbook ? next.workbook.configuration : configurationRef.current))} onSave={() => void task(() => save(), true)} onEditing={() => { setDirty(true); pendingSave.current = null; }} onPrintLoading={setPreparingPrint} /> : <WorksheetSurface
          snapshot={snapshot}
          configuration={configuration}
          run={preview?.run ?? null}
          disabled={busy}
          saving={saving}
          calculating={!preview}
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
          analysisStatus={draftAnalysisStatus ?? analyses.find(analysis => analysis.id === snapshot.analysisId)?.status ?? (savedVersion.current === null ? "DRAFT" : undefined)}
          onAnalysisStatusChange={updateActiveAnalysisStatus}
          onRequestConfirm={(title, description, onConfirm) => setConfirmation({ eyebrow: "Konfirmasi", title, description, onConfirm })}
          onSelectOffer={(selectionId, vendorName) => {
            if (snapshot && actor) mutate(() => {
              const next = selectSheetOffer(snapshot, parseStableId<"offer">(selectionId), actor);
              const source = next.worksheets.find(w => w.stage === "AHS")?.tables.flatMap(t => t.cells.map(cell => ({ cell, label: t.rows.find(row => row.id === cell.rowId)?.label }))).find(field =>
                field.cell.scope === next.activeProfile && field.label === "Sumber");
              edit(source?.cell.source.kind === "INPUT" ? updateCellInput(next, source.cell.scope, source.cell.id, { kind: "TEXT", text: vendorName }) : next);
            });
          }}
          onInput={(stage, label, value, kind, cell) => {
            if (snapshot) mutate(() => {
              const input = value.trim() ? { kind, text: value } : { kind: "UNSET" as const };
              if (cell) edit(updateCellInput(snapshot, cell.scope, cell.id, input));
              else edit(appendField(snapshot, stage, kind === "TEXT" && stage === "EVALUASI_VENDOR" ? "SHARED" : snapshot.activeProfile, label, input).snapshot);
            });
          }}
        />}
        {snapshot && <div className="sheet-caption">{snapshot.analysis.analysis.name}{preview?.run?.provisional?.status === "ERROR" ? " · ERROR" : ""}</div>}
        {analysisToDelete && <div className="analysis-delete-overlay" role="presentation" onClick={() => setAnalysisToDelete(null)}>
          <section className="analysis-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="analysis-delete-title" aria-describedby="analysis-delete-description" onClick={event => event.stopPropagation()}>
            <div className="analysis-delete-icon" aria-hidden="true"><AlertTriangle /></div>
            <div className="analysis-delete-content">
              <p className="analysis-delete-eyebrow">Hapus analisis</p>
              <h2 id="analysis-delete-title">Hapus “{analysisToDelete.analysis.name}”?</h2>
              <p id="analysis-delete-description">Seluruh data analisis dan workbook akan hilang permanen. Data yang sudah dihapus tidak dapat dipulihkan dan tindakan ini tidak bisa dibatalkan.</p>
              <div className="analysis-delete-actions">
                <button type="button" className="analysis-delete-cancel" onClick={() => setAnalysisToDelete(null)}>Batal</button>
                <button type="button" className="analysis-delete-confirm" disabled={busy} onClick={confirmRemoveAnalysis}><Trash2 aria-hidden="true" /> Hapus permanen</button>
              </div>
            </div>
          </section>
        </div>}
        {projectToDelete && <div className="analysis-delete-overlay" role="presentation" onClick={() => setProjectToDelete(null)}>
          <section className="analysis-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-description" onClick={event => event.stopPropagation()}>
            <div className="analysis-delete-icon" aria-hidden="true"><AlertTriangle /></div>
            <div className="analysis-delete-content">
              <p className="analysis-delete-eyebrow">Hapus proyek</p>
              <h2 id="project-delete-title">Hapus “{projectToDelete.name}”?</h2>
              <p id="project-delete-description">Proyek, seluruh analisis, dan semua workbook di dalamnya akan hilang permanen. Data tidak dapat dipulihkan dan tindakan ini tidak bisa dibatalkan.</p>
              <div className="analysis-delete-actions">
                <button type="button" className="analysis-delete-cancel" onClick={() => setProjectToDelete(null)}>Batal</button>
                <button type="button" className="analysis-delete-confirm" disabled={busy} onClick={confirmRemoveProject}><Trash2 aria-hidden="true" /> Hapus permanen</button>
              </div>
            </div>
          </section>
        </div>}
        {projectContextMenu && <div className="project-context-layer" role="presentation" onClick={() => setProjectContextMenu(null)} onContextMenu={event => event.preventDefault()}>
          <div className="project-context-menu" role="menu" style={{ left: projectContextMenu.x, top: projectContextMenu.y }} onClick={event => event.stopPropagation()}>
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setProjectToDelete(projectContextMenu.project); setProjectContextMenu(null); }}>
              <Trash2 aria-hidden="true" /> Hapus proyek
            </button>
          </div>
        </div>}
        {analysisToEdit && <div className="analysis-delete-overlay" role="presentation" onClick={() => setAnalysisToEdit(null)}>
          <section className="analysis-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="analysis-edit-title" onClick={event => event.stopPropagation()}>
            <div className="analysis-delete-content">
              <p className="analysis-delete-eyebrow">Edit analisis</p>
              <h2 id="analysis-edit-title">Pengaturan analisis</h2>
              <form className="analysis-edit-form" onSubmit={updateAnalysisMetadata}>
                <label><span>Nama analisis</span><input name="analysisName" defaultValue={analysisToEdit.name} required autoFocus /></label>
                <label><span>Status</span><select name="analysisStatus" defaultValue={analysisToEdit.status}>{ANALYSIS_STATUSES.map(status => <option key={status} value={status}>{analysisStatusLabel[status]}</option>)}</select></label>
                <div className="analysis-delete-actions"><button type="button" className="analysis-delete-cancel" onClick={() => setAnalysisToEdit(null)}>Batal</button><button type="submit" className="analysis-delete-confirm" disabled={busy}>Simpan</button></div>
              </form>
            </div>
          </section>
        </div>}
        {confirmation && <ConfirmationDialog {...confirmation} onConfirm={async () => { await confirmation.onConfirm(); setConfirmation(current => current === confirmation ? null : current); }}
          {...(confirmation.onSecondary ? { onSecondary: async () => { await confirmation.onSecondary!(); setConfirmation(current => current === confirmation ? null : current); } } : {})}
          onCancel={() => setConfirmation(null)} />}
      </>}
  </main>;
}
