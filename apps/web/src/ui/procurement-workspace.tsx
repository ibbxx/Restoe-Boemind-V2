"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { WorkbookSnapshot, WorksheetSnapshot } from "../domain/contracts.ts";
import type { StableId } from "../domain/ids.ts";
import { createStableId as id, parseStableId } from "../domain/ids.ts";
import { activateProfile, addOffer, addVendor, appendOfferRevision, selectOfferRevision, updateCellInput } from "../domain/commands.ts";
import { emptyWorkbook, appendField, changeWorkbook, pinOfferComponent, reviseFormula, reviewHppContext, nextOfferRevisionNumber } from "../domain/workflow.ts";
import { captureSnapshot } from "../domain/snapshots.ts";
import type { StoredRevision } from "../persistence/contracts.ts";
import type { SaveRequest, SaveOutcome } from "../application/contracts.ts";
import { FormulaEngine } from "../engine/formula-engine.ts";
import type { EngineConfiguration, EngineRun, Unit } from "../engine/contracts.ts";
import { api, ApiError, post, saveRequestBody } from "./workbook-client.ts";
import { WorksheetSurface } from "./worksheet-surface.tsx";

const unitOptions: { symbol: string; dimensions: Unit }[] = [
  { symbol: "1", dimensions: {} }, { symbol: "IDR", dimensions: { money: 1 } },
  { symbol: "L", dimensions: { volume: 1 } }, { symbol: "IDR/L", dimensions: { money: 1, volume: -1 } },
  { symbol: "kg", dimensions: { mass: 1 } }, { symbol: "IDR/kg", dimensions: { money: 1, mass: -1 } },
];
const stages: WorksheetSnapshot["stage"][] = ["EVALUASI_VENDOR", "KONVERSI_JAGAD", "AHS"];
function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function textInput(text: string) { return text.trim() ? { kind: "NUMERIC_TEXT" as const, text } : { kind: "UNSET" as const }; }
function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }

export function ProcurementWorkspace() {
  const [actor, setActor] = useState<StableId<"user"> | null>(null);
  const [busy, setBusy] = useState(true), [message, setMessage] = useState("Memeriksa sesi…"), [error, setError] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [analyses, setAnalyses] = useState<{ id: string; name: string }[]>([]);
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot | null>(null);
  const [head, setHead] = useState<StableId<"revision"> | null>(null), [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<readonly StoredRevision[]>([]), [runs, setRuns] = useState<readonly EngineRun[]>([]);
  const [configuration, setConfiguration] = useState<EngineConfiguration | null>(null);
  const [reason, setReason] = useState("");
  const pendingSave = useRef<SaveRequest | null>(null);
  const lastActor = useRef<StableId<"user"> | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  async function load(analysisId: string) {
    const [stored, revisions, calculations] = await Promise.all([
      api<StoredRevision | null>(`/api/workbook?analysisId=${analysisId}`),
      api<readonly StoredRevision[]>(`/api/workbook?view=history&analysisId=${analysisId}`),
      api<readonly EngineRun[]>(`/api/workbook?view=runs&analysisId=${analysisId}`),
    ]);
    if (!stored) throw new ApiError("NOT_FOUND_OR_FORBIDDEN");
    const s = captureSnapshot(stored.revision.snapshot);
    setSnapshot(s); setHead(stored.revision.revisionId); setHistory(revisions); setRuns(calculations);
    const matchingRuns = calculations.filter(r => s.policy.status === "CONFIGURED" && r.policyVersionId === s.policy.versionId);
    const sourceId = stored.revision.restoredFrom?.snapshotId ?? s.id;
    const inventory = (value: WorkbookSnapshot) => value.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => c.id))).sort().join(",");
    const matching = matchingRuns.findLast(r => r.snapshotId === sourceId) ?? matchingRuns.findLast(r => inventory(r.manifest.snapshot) === inventory(s));
    setConfiguration(matching?.manifest.configuration ?? null); setDirty(false); pendingSave.current = null;
    window.history.replaceState(null, "", "?analysisId=" + analysisId);
  }
  async function refreshProjects() { setProjects(await api("/api/workbook?view=projects")); }
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

  function edit(s: WorkbookSnapshot, config = configuration) {
    setSnapshot(s); setConfiguration(config); setDirty(true); pendingSave.current = null; setError(""); setMessage("Draft berubah; belum disimpan.");
  }
  function mutate(action: () => void) { try { action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Input tidak valid."); } }
  const preview = useMemo(() => {
    if (!snapshot || !configuration) return null;
    try { return { run: new FormulaEngine(configuration).evaluate(snapshot), error: "" }; }
    catch (cause) { return { run: null, error: cause instanceof Error ? cause.message : "Konfigurasi tidak valid." }; }
  }, [snapshot, configuration]);
  const cells = snapshot?.worksheets.flatMap(w => w.tables.flatMap(t => t.cells.map(c => ({ cell: c,
    label: t.rows.find(r => r.id === c.rowId)?.label ?? c.id, stage: w.stage })))) ?? [];

  async function save(intent: SaveRequest["intent"] = "SAVE_DRAFT") {
    if (!snapshot) return;
    const request: SaveRequest = pendingSave.current?.intent === intent ? pendingSave.current : {
      intent, expectedRevisionId: head, mutationId: id<"mutation">(), snapshot, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    pendingSave.current = request;
    const outcome = await api<SaveOutcome>("/api/workbook", { method: "POST", body: saveRequestBody(request) });
    if (outcome.status !== "SAVED") throw new ApiError(outcome.code);
    pendingSave.current = null;
    setSnapshot(outcome.revision.snapshot); setHead(outcome.revision.revisionId); setDirty(false);
    window.history.replaceState(null, "", "?analysisId=" + snapshot.analysisId);
    setMessage("Draft tersimpan.");
    await refreshProjects();
    setHistory(await api(`/api/workbook?view=history&analysisId=${snapshot.analysisId}`));
    if (configuration) {
      setMessage("Draft tersimpan; menghitung preview…");
      const result = await post<{ status: "STORED_PREVIEW"; run: EngineRun }>("CALCULATE", {
        analysisId: snapshot.analysisId, revisionId: outcome.revision.revisionId, configuration });
      setRuns(prior => [...prior, result.run]); setMessage("Draft dan preview tersimpan.");
    }
  }

  return <main className={actor ? "workbook-app" : "login-app"}>
    <header className="app-heading"><h1>Procurement Workbook</h1><span>{snapshot?.project.name ?? "Evaluasi Vendor · Konversi · AHS"}</span></header>
    <div role="status" aria-label="Status operasi" aria-live="polite">{busy ? "Memproses…" : message}</div>
    {error && <p role="alert">{error}</p>}
    {!actor ? <section><h2>Masuk</h2><form onSubmit={event => { const form = submit(event); const element = event.currentTarget;
      const password = element.elements.namedItem("password"); if (password instanceof HTMLInputElement) password.value = "";
      void task(async () => {
        const session = await api<{ actorId: StableId<"user"> }>("/api/session", { method: "POST", body: JSON.stringify({ operation: "LOGIN", email: field(form, "email"), password: String(form.get("password")) }) }, false);
        if (lastActor.current !== session.actorId) {
          setSnapshot(null); setHistory([]); setRuns([]); setConfiguration(null); setHead(null); setDirty(false); pendingSave.current = null;
          setProjects([]); setAnalyses([]); window.history.replaceState(null, "", "/");
        }
        lastActor.current = session.actorId; setActor(session.actorId); sessionChannel.current?.postMessage({ actorId: session.actorId });
        element.reset(); await refreshProjects(); setMessage("Berhasil masuk.");
      }); }}><fieldset disabled={busy}><label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Kata sandi<input name="password" type="password" autoComplete="current-password" required /></label><button>Masuk</button></fieldset></form></section>
    : <>
      <div className="workspace-actions"><span>Sesi aktif</span><span className="draft-label">{dirty ? "Belum disimpan" : snapshot ? "Tersimpan" : "Workbook baru"}</span>
        <select aria-label="Profil lembar" disabled={busy || !snapshot} value={snapshot?.activeProfile ?? "INU"} onChange={event => { if (snapshot) mutate(() => edit(activateProfile(snapshot, event.target.value))); }}><option value="INU">INU</option><option value="SOLAR_BAWAH">Solar Bawah</option></select>
        <button disabled={busy || !snapshot} onClick={() => void task(() => save())}>Simpan workbook</button>
        <button className="tools-toggle" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>Pengaturan workbook</button>
        <button disabled={busy} onClick={() => {
        if (dirty && !window.confirm("Keluar akan membuang draft yang belum disimpan. Lanjutkan?")) return;
        void task(async () => { await api("/api/session", { method: "DELETE" }, false); setActor(null); setSnapshot(null); setProjects([]); setAnalyses([]);
          sessionChannel.current?.postMessage({ actorId: null }); lastActor.current = null;
          setHistory([]); setRuns([]); setConfiguration(null); setDirty(false); pendingSave.current = null; window.history.replaceState(null, "", "/"); setMessage("Berhasil keluar."); });
      }}>Keluar</button></div>
      <WorksheetSurface snapshot={snapshot} run={preview?.run ?? null} disabled={busy}
        onSelectOffer={revisionId => { if (snapshot) mutate(() => edit(selectOfferRevision(snapshot, revisionId))); }}
        onInput={(stage, label, value, kind, cell) => { if (snapshot) mutate(() => {
          const input = value.trim() ? { kind, text: value } : { kind: "UNSET" as const };
          if (cell) edit(updateCellInput(snapshot, cell.scope, cell.id, input));
          else edit(appendField(snapshot, stage, kind === "TEXT" && stage === "EVALUASI_VENDOR" ? "SHARED" : snapshot.activeProfile, label, input).snapshot);
        }); }} />
      <div className="sheet-caption">{snapshot?.analysis.analysis.name ?? "Buka pengaturan workbook untuk membuat atau memuat Analysis."} · Preview{preview?.run ? " · " + preview.run.status : ""}</div>
      <details className="workbook-tools" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}><summary>Kelola proyek, penawaran, formula dan histori</summary>
      <fieldset disabled={busy}>
      <section><h2>Proyek dan Analysis</h2>
        <div className="row"><label>Proyek tersimpan<select aria-label="Proyek tersimpan" defaultValue="" onChange={event => { const selected = event.target.value;
          setAnalyses([]); if (selected) void task(async () => { setAnalyses(await api(`/api/workbook?view=analyses&projectId=${selected}`)); setMessage("Pilih Analysis."); });
        }}><option value="">Pilih proyek</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Analysis tersimpan<select aria-label="Analysis tersimpan" value={snapshot?.analysisId ?? ""} onChange={event => {
          const selected = event.target.value; if (!selected) return;
          if (dirty && !window.confirm("Muat Analysis lain dan buang draft yang belum disimpan?")) return;
          void task(async () => { await load(selected); setMessage("Analysis dimuat."); });
        }}><option value="">Pilih Analysis</option>{analyses.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
        <form onSubmit={event => { const form = submit(event); mutate(() => {
          if (dirty && !window.confirm("Buat workbook baru dan buang draft yang belum disimpan?")) return;
          const projectId = field(form, "projectId");
          const existing = projects.find(p => p.id === projectId);
          const s = existing ? emptyWorkbook(existing.name, field(form, "analysisName"), parseStableId<"project">(existing.id))
            : emptyWorkbook(field(form, "projectName"), field(form, "analysisName"));
          edit(s, null); setHead(null); setHistory([]); setRuns([]); setReason("");
          window.history.replaceState(null, "", "/");
        }); }}><h3>Workbook baru</h3><label>Induk proyek<select aria-label="Induk proyek" name="projectId"><option value="">Proyek baru</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Nama proyek baru<input name="projectName" /></label><label>Nama Analysis<input name="analysisName" required /></label><button>Buat workbook kosong</button></form>
      </section>
      {snapshot && <>
        <section><h2>{snapshot.project.name} / {snapshot.analysis.analysis.name}</h2>
          <p>{dirty ? "Belum disimpan" : "Tersimpan"} · Revisi: <span data-testid="revision-id">{head ?? "baru"}</span></p>
          <label>Profil<select aria-label="Profil" value={snapshot.activeProfile} onChange={event => mutate(() => edit(activateProfile(snapshot, event.target.value)))}>
            <option value="INU">INU</option><option value="SOLAR_BAWAH">Solar Bawah</option></select></label>
          <label>Alasan perubahan<input value={reason} onChange={event => { setReason(event.target.value); pendingSave.current = null; }} /></label>
          <div className="toolbar"><button onClick={() => void task(() => save())}>Simpan</button><button onClick={() => void task(() => save("CONFIRM_RESULT"))}>Finalisasi</button>
          <button disabled={!head} onClick={() => { if (!dirty || window.confirm("Muat ulang dan buang draft yang belum disimpan?")) void task(async () => { await load(snapshot.analysisId); setMessage("Data dimuat ulang."); }); }}>Muat ulang tersimpan</button></div>
          <p>Finalisasi bisnis belum tersedia. Preview aritmetika tidak menyatakan kelayakan vendor, pajak, atau hasil bisnis final.</p>
        </section>
        <section><h2>Vendor dan penawaran</h2>
          <form onSubmit={event => { const form = submit(event); const element = event.currentTarget; mutate(() => {
            edit(addVendor(snapshot, { id: id<"vendor">(), analysisId: snapshot.analysisId, name: field(form, "vendorName") })); element.reset();
          }); }}><label>Nama vendor<input name="vendorName" required pattern=".*\S.*" /></label><button>Tambah vendor</button></form>
          <form onSubmit={event => { const form = submit(event); const element = event.currentTarget; mutate(() => {
            edit(addOffer(snapshot, { id: id<"offer">(), analysisId: snapshot.analysisId, vendorId: parseStableId<"vendor">(field(form, "vendor")), label: field(form, "offerLabel") })); element.reset();
          }); }}><label>Vendor<select aria-label="Vendor" name="vendor" required><option value="">Pilih vendor</option>{snapshot.analysis.vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label>Nama penawaran<input name="offerLabel" required pattern=".*\S.*" /></label><button>Tambah penawaran</button></form>
          <form onSubmit={event => { const form = submit(event); mutate(() => {
            const offerId = parseStableId<"offer">(field(form, "offer"));
            const revisionNumber = nextOfferRevisionNumber(offerId, [snapshot, ...history.map(h => h.revision.snapshot)]);
            const labels = field(form, "components").split("\n").map(line => { const separator = line.indexOf(":");
              if (separator < 1 || !line.slice(0, separator).trim() || !line.slice(separator + 1).trim()) throw new Error("Gunakan nama komponen: nilai, satu per baris.");
              return { id: id<"offer-value">(), label: line.slice(0, separator).trim(), input: textInput(line.slice(separator + 1).trim()) }; });
            edit(appendOfferRevision(snapshot, { id: id<"offer-revision">(), offerId, revisionNumber, values: labels }));
          }); }}><label>Penawaran<select aria-label="Penawaran" name="offer" required><option value="">Pilih penawaran</option>{snapshot.analysis.offers.map(o => <option key={o.id} value={o.id}>{snapshot.analysis.vendors.find(v => v.id === o.vendorId)?.name} / {o.label}</option>)}</select></label>
          <label>Komponen revisi baru (nama: nilai, satu per baris)<textarea name="components" required placeholder="Harga dasar: 20000" /></label><button>Tambah revisi / negosiasi</button></form>
          <label>Revisi penawaran terpilih<select aria-label="Revisi penawaran terpilih" value={snapshot.selectedOfferRevisionId ?? ""} onChange={event => mutate(() => edit(selectOfferRevision(snapshot, event.target.value || null)))}><option value="">Belum dipilih</option>
            {snapshot.analysis.offerRevisions.map(r => { const o = snapshot.analysis.offers.find(o => o.id === r.offerId)!;
              return <option key={r.id} value={r.id}>{snapshot.analysis.vendors.find(v => v.id === o.vendorId)?.name} / {o.label} / revisi {r.revisionNumber}</option>; })}</select></label>
          {snapshot.analysis.offerRevisions.map(r => <article key={r.id}><strong>{snapshot.analysis.offers.find(o => o.id === r.offerId)?.label} · revisi {r.revisionNumber}{snapshot.selectedOfferRevisionId === r.id ? " · DIPILIH" : ""}</strong>
            <ul>{r.values.map(v => <li key={v.id}>{v.label}: {v.input.kind === "UNSET" ? "EMPTY" : v.input.text}</li>)}</ul></article>)}
        </section>
        <section><h2>Kebijakan aritmetika dan satuan</h2><p>Konfigurasi ini hanya untuk preview. Satuan tidak dikonversi otomatis.</p>
          <form key={configuration?.policyVersionId ?? snapshot.analysisId} onSubmit={event => { const form = submit(event); mutate(() => {
            const policyVersionId = id<"policy">();
            const next: EngineConfiguration = { version: id<"policy">(), policyVersionId, decimal: {
              scale: Number(field(form, "scale")), rounding: field(form, "rounding") as "DOWN" | "HALF_UP" | "HALF_EVEN", roundAt: "EVERY_OPERATION" },
              aggregates: configuration?.aggregates ?? [], selectionDependentCellIds: configuration?.selectionDependentCellIds ?? [],
              units: cells.flatMap(({ cell }) => { const unit = unitOptions.find(u => u.symbol === field(form, cell.id)); return unit ? [{ cellId: cell.id, ...unit }] : []; }) };
            new FormulaEngine(next);
            edit(changeWorkbook(snapshot, { policy: { status: "CONFIGURED", versionId: policyVersionId } }), next);
          }); }}><label>Skala desimal<input name="scale" type="number" min="0" max="36" step="1" required defaultValue={configuration?.decimal.scale} /></label>
          <label>Pembulatan<select aria-label="Pembulatan" name="rounding" required defaultValue={configuration?.decimal.rounding ?? ""}><option value="">Pilih</option><option>DOWN</option><option>HALF_UP</option><option>HALF_EVEN</option></select></label>
          <p>Pembulatan setiap operasi (EVERY_OPERATION).</p>
          {cells.map(({ cell, label }) => <label key={cell.id}>Satuan {label}<select aria-label={"Satuan " + label} name={cell.id} defaultValue={configuration?.units.find(u => u.cellId === cell.id)?.symbol ?? ""}><option value="">Belum dikonfigurasi</option>{unitOptions.map(u => <option key={u.symbol}>{u.symbol}</option>)}</select></label>)}
          <button>Terapkan konfigurasi preview</button></form>
        </section>
        <section><h2>Worksheet · {snapshot.activeProfile}</h2>
          {stages.map(stage => <div key={stage}><h3>{stage}</h3>{cells.filter(c => c.stage === stage && (c.cell.scope === "SHARED" || c.cell.scope === snapshot.activeProfile)).map(({ cell, label }) => {
            const result = preview?.run?.results.find(r => r.cellId === cell.id);
            const formula = snapshot.formulas.find(f => f.targetCellId === cell.id);
            const pinnedSource = snapshot.mappings.some(m => m.sourceCellId === cell.id && m.sourceComponent.startsWith("offer-value:"));
            return <article key={cell.id} aria-label={"Field " + label} data-testid={"cell-" + cell.id}><label>{label}{cell.source.kind === "INPUT" && !pinnedSource ?
              <input key={snapshot.analysisId + ":" + head} aria-label={label} value={cell.source.input.kind === "UNSET" ? "" : cell.source.input.text} onChange={event => mutate(() => edit(updateCellInput(snapshot, cell.scope, cell.id, textInput(event.target.value))))} />
              : <span className="read-only">{cell.source.kind === "INPUT" ? (cell.source.input.kind === "UNSET" ? "EMPTY" : cell.source.input.text) : cell.source.kind}</span>}</label>
              <code>{`@{${cell.id}}`}</code>{formula && <><p>Formula: <code>{formula.expression}</code> · {formula.sourceKind}</p>
                <form onSubmit={event => { const form = submit(event); mutate(() => edit(reviseFormula(snapshot, formula.id, field(form, "expression")))); }}>
                  <label>Ekspresi {label}<textarea aria-label={"Ekspresi " + label} name="expression" key={formula.versionId} defaultValue={formula.expression} required /></label>
                  <button>Ubah formula {label}</button>
                </form></>}
              <output aria-label={"Hasil " + label}>{result ? "value" in result ? result.value : "text" in result ? result.text : result.status + ": " + result.code : "Belum dihitung"}</output>
            </article>;
          })}</div>)}
          <form onSubmit={event => { const form = submit(event); const element = event.currentTarget; mutate(() => {
            const added = appendField(snapshot, field(form, "stage") as WorksheetSnapshot["stage"], snapshot.activeProfile, field(form, "fieldLabel"), textInput(field(form, "initialValue")), field(form, "expression"));
            edit(added.snapshot); element.reset();
          }); }}><h3>Tambah input / formula</h3><label>Tahap<select aria-label="Tahap" name="stage">{stages.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Nama field<input name="fieldLabel" required pattern=".*\S.*" /></label><label>Input awal<input name="initialValue" /></label>
          <label>Formula (opsional, gunakan referensi stable ID)<textarea name="expression" placeholder="@{UUID} * @{UUID}" /></label><button>Tambah field</button></form>
          {preview?.error && <p role="alert">{preview.error}</p>}
          <p data-testid="preview-state">Preview: {preview?.run?.status ?? "Belum dikonfigurasi"} · Finalisasi memerlukan keputusan bisnis.</p>
          <p>Konteks HPP: <strong data-testid="hpp-review">{snapshot.profiles[snapshot.activeProfile].reviewContext?.decisionStatus ?? "Belum ditinjau"}</strong> · run {snapshot.profiles[snapshot.activeProfile].hppBase.contextRunId ?? "belum dicatat"}</p>
          <button disabled={dirty || !configuration || !runs.some(r => r.manifest.revisionId === head && r.manifest.snapshot.activeProfile === snapshot.activeProfile)} onClick={() => mutate(() => {
            const run = runs.filter(r => r.manifest.revisionId === head && r.manifest.snapshot.activeProfile === snapshot.activeProfile).at(-1);
            if (!run || !configuration) throw new Error("Simpan dan hitung terlebih dahulu.");
            edit(reviewHppContext(snapshot, run, configuration));
          })}>Catat konteks HPP dari run tersimpan</button>
        </section>
        <section><h2>Mapping penawaran → Konversi</h2><p>Aktifkan hanya komponen dan satuan yang telah ditinjau. Terapkan ulang secara manual bila mengganti revisi pilihan.</p>
          <form onSubmit={event => { const form = submit(event); mutate(() => {
            if (!configuration) throw new Error("Terapkan konfigurasi satuan terlebih dahulu.");
            const targetId = parseStableId<"cell">(field(form, "target"));
            const unit = configuration.units.find(u => u.cellId === targetId); if (!unit) throw new Error("Satuan target belum dikonfigurasi.");
            const pinned = pinOfferComponent(snapshot, parseStableId<"offer-value">(field(form, "component")), targetId, unit.symbol, actor, field(form, "mappingReason"));
            edit(pinned.snapshot, { ...configuration, version: id<"policy">(), units: [...configuration.units, { ...unit, cellId: pinned.sourceCellId }],
              selectionDependentCellIds: [...new Set([...configuration.selectionDependentCellIds, targetId])] });
          }); }}><label>Komponen terpilih<select aria-label="Komponen terpilih" name="component" required><option value="">Pilih komponen</option>{snapshot.analysis.offerRevisions.find(r => r.id === snapshot.selectedOfferRevisionId)?.values.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
          <label>Target Konversi<select aria-label="Target Konversi" name="target" required><option value="">Pilih target</option>{cells.filter(({ cell, stage }) => stage === "KONVERSI_JAGAD" && cell.scope === snapshot.activeProfile && cell.source.kind !== "FORMULA").map(({ cell, label }) => <option key={cell.id} value={cell.id}>{label}</option>)}</select></label>
          <label>Alasan mapping<input name="mappingReason" required pattern=".*\S.*" /></label><label className="check"><input type="checkbox" required />Saya meninjau komponen, basis harga, dan satuan untuk preview ini.</label><button>Aktifkan mapping preview</button></form>
          {snapshot.mappings.filter(m => m.scope === snapshot.activeProfile).map(m => <p key={m.id}>Mapping {m.status} · revisi {m.provenance.sourceRef} · {m.provenance.sourceRef === snapshot.selectedOfferRevisionId ? "Pilihan sesuai" : "NEEDS_REVIEW: pilihan berbeda"} · {m.provenance.reason}</p>)}
        </section>
        <section><h2>Histori tersimpan</h2><p>{history.length} revisi · {runs.length} run kalkulasi</p>
          {history.map((entry, index) => <article key={entry.revision.revisionId}><p>Revisi {index + 1} · {entry.changeEvent.action} · {entry.revision.savedAt} · {entry.changeEvent.reason ?? "Tanpa alasan"}</p>
            <p>Aktor: {entry.actorId} · {entry.changeEvent.changes.map(c => c.action).join(", ")}</p>
            <button onClick={() => { if (dirty && !window.confirm("Restore akan membuang draft yang belum disimpan. Lanjutkan?")) return;
              void task(async () => {
                const outcome = await post<SaveOutcome>("RESTORE", { analysisId: snapshot.analysisId, sourceRevisionId: entry.revision.revisionId, expectedRevisionId: head, mutationId: id<"mutation">(), reason: reason || "Restore melalui UI" });
                if (outcome.status !== "SAVED") throw new ApiError(outcome.code);
                await load(snapshot.analysisId); setMessage("Restore tersimpan sebagai revisi baru.");
              }); }}>Restore revisi {index + 1}</button>
            <details><summary>Snapshot dan perubahan revisi {index + 1}</summary><pre>{JSON.stringify(entry.changeEvent, null, 2)}</pre></details>
          </article>)}
          {runs.map(run => <details key={run.id}><summary>Run {run.id} · {run.status} · {run.manifest.revisionId === head ? "Revisi aktif" : "Historis / STALE"}</summary><pre>{JSON.stringify(run, null, 2)}</pre></details>)}
        </section>
      </>}
      </fieldset>
      </details>
    </>}
  </main>;
}
