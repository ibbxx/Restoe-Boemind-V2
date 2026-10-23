"use client";

import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { MenuToggleIcon } from "../components/ui/menu-toggle-icon.tsx";
import type { AhsSection, WorkbookSnapshot } from "../domain/contracts.ts";
import type { EngineConfiguration, NodeResult } from "../engine/contracts.ts";
import { addAhsField, ahsFields, removeAhsField, renameAhsField } from "../domain/ahs-fields.ts";
import { addAhsItem, ahsGroups, ahsLabel, removeAhsEntry, renameAhsEntry } from "../domain/ahs-groups.ts";

interface CommonProps {
  snapshot: WorkbookSnapshot;
  section: AhsSection;
  sections?: readonly AhsSection[];
  configuration: EngineConfiguration | null;
  results?: readonly NodeResult[];
  disabled: boolean;
  error: string;
  addButtonRef: Ref<HTMLButtonElement>;
  onBeforeOpen?: () => boolean;
}
type Props = CommonProps & (
  { view?: "INTERNAL"; onApply: (action: () => WorkbookSnapshot) => boolean; onAdd?: never } |
  { view: "EXTERNAL"; onApply?: never; onAdd: (section: AhsSection, groupId: string | null, groupName: string, itemName: string) => boolean }
);

const titles = { group: "Tambah kelompok", item: "Tambah uraian", rename: "Ubah nama", remove: "Hapus" };
type Action = keyof typeof titles;

const sectionLabels: Record<AhsSection, string> = { INFORMASI: "Informasi Analisis", PENDAPATAN: "Pendapatan", BIAYA: "Biaya", LABA: "Laba" };

export function AhsActions({ snapshot, section, sections = [section], configuration, results = [], disabled, error, onApply, onAdd, view = "INTERNAL", onBeforeOpen, addButtonRef }: Props) {
  const menuRef = useRef<HTMLDetailsElement>(null), dialogRef = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<AhsSection>(section);
  const [action, setAction] = useState<Action>("item");
  const [groupId, setGroupId] = useState(""), [itemId, setItemId] = useState("");
  const [name, setName] = useState(""), [firstItem, setFirstItem] = useState("");
  const grouped = activeSection === "BIAYA" || activeSection === "PENDAPATAN";
  const groups = grouped ? view === "EXTERNAL" ? snapshot.externalAhs?.groups.filter(group => group.profile === snapshot.activeProfile && (group.section ?? "BIAYA") === activeSection) ?? [] : ahsGroups(snapshot, snapshot.activeProfile, activeSection) : [];
  const fields = !grouped ? view === "EXTERNAL" ? snapshot.externalAhs?.fields.filter(field => field.profile === snapshot.activeProfile && field.section === activeSection) ?? [] : ahsFields(snapshot, activeSection) : [];
  const field = fields.find(f => f.valueCellId === itemId);
  const group = groups.find(g => g.id === groupId);
  const sectionName = sectionLabels[activeSection];
  const titleId = `ahs-${view === "EXTERNAL" ? "external-" : ""}${activeSection}-action-title`;
  const menuLabel = view === "EXTERNAL" ? "Aksi AHS Eksternal" : "Aksi AHS";
  const item = group?.items.find(item => item.priceCellId === itemId);
  const manage = action === "rename" || action === "remove";
  const removable = groups.filter(g => !g.builtin || g.items.some(item => !item.builtin));
  const editable = action === "remove" ? removable : groups;
  const labelOf = (entry: { name: string; labelCellId: string | null }) => ahsLabel(snapshot, entry, results);
  const targetAllowed = grouped ? !!group && (itemId ? !!item && (action !== "remove" || !item.builtin) : action !== "remove" || !group.builtin) : !!field;

  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && menuRef.current && !menuRef.current.contains(event.target)) menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function open(next: Action) {
    if (disabled || (onBeforeOpen && !onBeforeOpen())) return;
    const initial = (next === "remove" ? removable : groups)[0];
    const initialItem = next === "remove" && initial?.builtin ? initial.items.find(item => !item.builtin) : undefined;
    setAction(next); setGroupId(initial?.id ?? ""); setItemId(grouped ? initialItem?.priceCellId ?? "" : fields[0]?.valueCellId ?? "");
    setName(!grouped ? fields[0] ? labelOf(fields[0]) : "" : next === "group" ? "" : initialItem ? labelOf(initialItem) : initial ? labelOf(initial) : ""); setFirstItem("");
    if (menuRef.current) menuRef.current.open = false;
    dialogRef.current?.showModal();
  }

  function selectGroup(value: string) {
    const next = groups.find(g => g.id === value), entry = action === "remove" && next?.builtin ? next.items.find(item => !item.builtin) : undefined;
    setGroupId(value); setItemId(entry?.priceCellId ?? ""); setName(entry ? labelOf(entry) : next ? labelOf(next) : "");
  }

  return <>
    <details className="vendor-table-actions ahs-global-actions" ref={menuRef} onClick={event => event.stopPropagation()}
      onToggle={event => setMenuOpen(event.currentTarget.open)}
      onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.currentTarget.open = true;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" || (current < 0 && event.key === "ArrowUp") ? buttons.length - 1
          : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }}>
      <summary aria-label={menuLabel} aria-haspopup="menu" title={menuLabel}>
        <MenuToggleIcon open={menuOpen} duration={500} aria-hidden="true" />
      </summary>
      <div role="menu" aria-label={menuLabel}>
        <div className="ahs-menu-heading"><span>Kelola AHS</span><strong>{sectionName}</strong></div>
        <div className="ahs-section-picker" role="group" aria-label="Bagian AHS">
          {sections.map(candidate => <button key={candidate} type="button" role="menuitemradio" aria-checked={activeSection === candidate}
            className={"ahs-section-" + candidate.toLowerCase() + (activeSection === candidate ? " is-active" : "")} onClick={() => setActiveSection(candidate)}>{sectionLabels[candidate]}</button>)}
        </div>
        <div className="ahs-action-list" role="group" aria-label={`Aksi ${sectionName}`}>
          {(Object.keys(titles) as Action[]).filter(key => (grouped || key !== "group") && (view !== "EXTERNAL" || key === "group" || key === "item")).map(key => <button key={key} ref={key === "item" ? addButtonRef : undefined} type="button" role="menuitem"
            disabled={disabled || ((key === "rename" || key === "remove") && !(grouped ? (key === "remove" ? removable : groups).length : fields.length)) || (key === "remove" && !configuration)}
            className={key === "remove" ? "menu-danger" : undefined} onClick={() => open(key)}>{titles[key]}</button>)}
        </div>
      </div>
    </details>
    <dialog ref={dialogRef} className="vendor-delete-dialog ahs-dialog" aria-labelledby={titleId}
      onClick={event => event.stopPropagation()} onClose={() => menuRef.current?.querySelector("summary")?.focus()}>
      <form onSubmit={event => {
        event.preventDefault();
        if (disabled || (manage && !targetAllowed)) return;
        if (view === "EXTERNAL") {
          if (onAdd!(activeSection, grouped && action === "item" ? groupId : null, action === "group" ? name : "", firstItem)) dialogRef.current?.close();
          return;
        }
        if (onApply!(() => {
          if (!grouped) {
            if (action === "item") return addAhsField(snapshot, activeSection, firstItem, activeSection === "LABA" ? "NUMBER" : "TEXT");
            if (action === "rename") return renameAhsField(snapshot, itemId, name);
            return removeAhsField(snapshot, itemId, configuration!);
          }
          if (action === "group") return addAhsItem(snapshot, null, firstItem, name, activeSection);
          if (action === "item") return addAhsItem(snapshot, groupId, firstItem, "", activeSection);
          if (action === "rename") return renameAhsEntry(snapshot, groupId, itemId || null, name, activeSection);
          return removeAhsEntry(snapshot, groupId, itemId || null, configuration!, activeSection);
        })) dialogRef.current?.close();
      }}>
        <header><div><h2 id={titleId}>{titles[action]} · {sectionName}</h2><p>Profil {snapshot.activeProfile === "INU" ? "INU" : "SKP"}</p></div>
          <button type="button" className="dialog-close" aria-label="Tutup" onClick={() => dialogRef.current?.close()}>×</button></header>
        {grouped && action !== "group" && <label>Kelompok<select value={groupId} onChange={event => selectGroup(event.target.value)} required>
          {(manage ? editable : groups).map(group => <option key={group.id} value={group.id}>{labelOf(group)}</option>)}
        </select></label>}
        {grouped && manage && <label>Yang dikelola<select value={itemId} onChange={event => {
          setItemId(event.target.value); const next = group?.items.find(item => item.priceCellId === event.target.value);
          setName(next ? labelOf(next) : group ? labelOf(group) : "");
        }}>
          {(action !== "remove" || !group?.builtin) && <option value="">Seluruh kelompok</option>}
          {group?.items.filter(item => action !== "remove" || !item.builtin).map(item => <option key={item.priceCellId} value={item.priceCellId}>{labelOf(item)}</option>)}
        </select></label>}
        {!grouped && manage && <label>Uraian<select value={itemId} required onChange={event => {
          setItemId(event.target.value); const selected = fields.find(f => f.valueCellId === event.target.value);
          setName(selected ? labelOf(selected) : "");
        }}>{fields.map(f => <option key={f.valueCellId} value={f.valueCellId}>{labelOf(f)}</option>)}</select></label>}
        {(action === "group" || action === "rename") && <label>{action === "group" ? "Nama kelompok" : "Nama baru"}
          <input value={name} onChange={event => setName(event.target.value)} required /></label>}
        {(action === "group" || action === "item") && <label>Nama uraian<input value={firstItem} onChange={event => setFirstItem(event.target.value)} required /></label>}
        {action === "remove" && <p role="status">{!grouped ? `Hapus uraian “${field ? labelOf(field) : ""}” beserta nilainya?` : item ? `Hapus uraian “${labelOf(item)}” beserta nilainya?`
          : `Hapus kelompok “${group ? labelOf(group) : ""}” beserta ${group?.items.length ?? 0} uraian dan nilainya?`}</p>}
        {error && <p role="alert" className="vendor-delete-error">{error}</p>}
        <footer><button type="button" onClick={() => dialogRef.current?.close()}>Batal</button>
          <button type="submit" className={action === "remove" ? "vendor-delete-confirm" : "vendor-component-confirm"}
            disabled={disabled || (manage && !targetAllowed) || (action === "remove" && !configuration)}>{titles[action]}</button></footer>
      </form>
    </dialog>
  </>;
}
