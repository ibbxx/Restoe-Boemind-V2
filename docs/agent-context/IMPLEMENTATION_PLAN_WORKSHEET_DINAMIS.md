# Implementasi Plan — Worksheet Dinamis (kandidat Fase 6)

Status: **RENCANA. Belum disetujui, belum ada kode yang diubah.** Dokumen ini tidak
mengotorisasi fase berikutnya dan tidak mengesahkan keputusan bisnis apa pun.

Tanggal draf: 2026-10-15. Acuan: [BUSINESS_RULES.md](./BUSINESS_RULES.md),
[ARCHITECTURE.md](./ARCHITECTURE.md), [OPEN_DECISIONS.md](./OPEN_DECISIONS.md),
[PHASE5_VERIFICATION.md](./PHASE5_VERIFICATION.md), `SPESIFIKASI_WORKSHEET.md`
(terutama §6 struktur dinamis dan §7 mesin formula), dan `PRD…AHS.md` §14.5.

Label: **R** = kebutuhan pengguna yang d itetapkan; **F** = fakta kode/artefak yang
dapat diperiksa; **U** = usulan desain yang belum menjadi kebijakan bisnis;
**K** = keputusan yang belum disahkan dan harus ditanyakan ke pengguna/owner.

---

## 1. Tujuan dan non-tujuan

### 1.1 Tujuan [R]

1. Halaman `/` **hanya menampilkan worksheet** (`data-testid="procurement-sheet"`),
   tanpa blok kontrol `<fieldset>` di bawahnya.
2. Worksheet **dinamis**: tabel, baris, dan kolom dapat ditambah/diubah, serta
   **merge/split sel** mengikuti alur, audit, dan gaya `AHAS Sistem`.
3. Setiap sel dapat diberi **formula** (berdasarkan referensi sel/ID), dijalankan
   mesin yang sama di luar UI.

### 1.2 Non-tujuan

Solver Profit MUE, finalisasi `CONFIRMED`, kebijakan pajak/unit/rounding, dan
aturan bisnis lain yang masih `BELUM DIPUTUSKAN` tetap di luar rencana ini.

---

## 2. Kondisi saat ini (FAKTA dari kode)

| Aspek | Fakta | Batas yang ditimbulkan |
|---|---|---|
| Renderer | `src/ui/worksheet-surface.tsx` menyusun tabel **hardcoded di JSX** (`vendorRows`, `conversionRows`, `costGroups`, `summaryRows`), dengan `colSpan`/`rowSpan` literal. | Bentuk sheet tidak berasal dari data; menambah/menggeser baris tidak mungkin dari UI. |
| Pengikatan sel | `slot()`/`find()` mengikat sel snapshot ke slot tetap **berdasarkan label baris** (`normalized(label)`). Label ganda → sel sengaja dibiarkan terpisah (tidak dianggap satu slot). | Binding rapuh; tidak ada identitas posisi/merge. |
| Tambah field | `appendField()` di `src/domain/workflow.ts` membuat **tabel 1×1 baru** per field. | Field baru tidak menyatu ke grid AHS; tidak ada “tambah baris ke tabel yang ada”. |
| Model tabel | `TableSnapshot` = rows[], columns[], rowOrder[], columnOrder[], cells[] (`src/domain/contracts.ts`). | **Tidak ada konsep merge/span** sama sekali. |
| Command yang ada | `updateCellInput`, `reorderTable` (display saja), `reviseFormula`, `appendField`, `pinOfferComponent`, `activateProfile`, `selectOfferRevision`. | Tidak ada `addRow`/`addColumn`/`merge`/`setFormulaForExistingCell`/`deleteRow`. |
| Engine | `FormulaEngine` menerima `WorkbookSnapshot` + `EngineConfiguration` (units, aggregates, selectionDependentCellIds); ekspresi pakai `+ − × /`, tanda kurung, persen, `SUM`, dan **referensi sel by ID**. | Sel baru otomatis ikut evaluasi selama ada di snapshot. Agregat harus didaftarkan eksplisit. |
| UI lain | `src/ui/procurement-workspace.tsx` merender `WorksheetSurface` **plus** `.sheet-caption` dan `<details class="workbook-tools">` berisi `<fieldset>` besar (Proyek/Analysis, vendor/offer, formula, histori, simpan, profil). | Semua kemampuan membuat data ada di fieldset itu. |
| Gaya | `src/app/globals.css` sudah memuat gaya AHAS (`.ahs-sheet`, `.income-row` hijau `#0f0`, `.cost-row` merah `#f66`, `.profit-row` abu, `.ahs-title` kuning, grid 101×23,5 px). | Gaya visual dapat dipertahankan saat renderer dibuat data-driven. |

**Kesimpulan F:** sheet saat ini adalah *template tetap yang mengikat sel lewat label*.
Agar “dinamis + merge + formula per sel”, diperlukan **tiga hal baru**: (a) model
merge/span, (b) command struktural, (c) renderer data-driven. `appendField` yang
membuat tabel 1×1 tidak cukup dan harus dilengkapi, bukan diganti diam-diam.

---

## 3. Invariant yang wajib dijaga (dari AGENTS.md/BUSINESS_RULES)

- Stable ID untuk Analysis/Table/Row/Column/Cell/Formula; posisi hanya `display_order`.
- **Tidak ada aritmetika bisnis di React**; UI hanya menampilkan hasil engine.
- Snapshot historis immutable; perubahan = revisi baru lewat Save/Restore.
- Tidak ada auto-binding O/S/B/H; H tetap input manual.
- Missing reference **bukan** nol; `EMPTY`/`ZERO_EXPLICIT`/`ERROR` dibedakan.
- Satu writer aktif per target (override → mapping → default) tanpa konflik.
- Perubahan struktur yang tersimpan tercatat sebagai `ChangeEvent` (`STRUCTURE_CHANGED`/
  `FORMULA_CHANGED`), bukan setiap ketikan draft.
- Tidak mengarang aturan bisnis untuk menutup celah implementasi.

---

## 4. Keputusan yang harus ditetapkan sebelum coding [K]

Jangan menebak. Ini menentukan bentuk kontrak dan tidak boleh ditebak dari “lanjutkan”.

| ID | Pertanyaan | Mengapa penting |
|---|---|---|
| **D1** | Ke mana kontrol `fieldset` (buat proyek/vendor/offer, histori, simpan) dipindah? Opsi: route terpisah `/pengaturan`, drawer, atau panel samping yang bisa disembunyikan. | Menghapus tanpa memindahkan = kehilangan kemampuan membuat/memuat data. |
| **D2** | **Merge bersifat tampilan saja, atau memengaruhi identitas/agregat?** (mis. sel gabungan tetap diwakili sel anchor + sel tertutup, atau satu sel baru). | Menentukan apakah merge mengubah referensi formula/agregat dan audit. |
| **D3** | Apakah baris/kolom baru wajib punya tipe/unit/scope eksplisit, atau boleh `UNSET` dulu? | Menentukan validasi `addRow`/`addColumn`. |
| **D4** | Jenis amount (`per unit` / `fixed` / `persen`) — apakah menjadi atribut sel yang perlu diisi di UI sekarang, atau tetap ditunda (K7)? | Menentukan apakah `K7` harus ditetapkan lebih dulu. |
| **D5** | Formula baru pada sel: langsung `ACTIVE` (override operasional) atau `DRAFT` sampai ditinjau? | Menentukan status `FormulaDefinition` & lencana provenance. |
| **D6** | Apakah struktur AHS default (grup biaya, baris pendapatan) tetap menjadi *template awal yang bisa diedit*, atau workbook baru benar-benar kosong? | Saat ini workbook baru kosong; gaya AHAS hilang sampai dibuat manual. |

**Rekomendasi U (untuk dibahas):** D1 = route terpisah `/pengaturan`; D2 = merge
tampilan-saja dengan sel anchor + daftar sel tertutup (agar referensi tetap by ID);
D3 = wajib label, tipe/unit boleh `UNSET`; D4 = tunda (K7 tetap terbuka);
D5 = `DRAFT` dengan tombol “aktifkan”; D6 = template AHS opsional ber-ID, bukan angka contoh.

---

## 5. Model domain yang diusulkan [U]

### 5.1 Merge/span (baru)

Tambahkan pada `TableSnapshot` (tanpa menyentuh `CellSnapshot`):

```ts
readonly merges: readonly {
  readonly id: StableId<"merge">;
  readonly anchorCellId: StableId<"cell">;   // sel kiri-atas
  readonly rowSpan: number;                   // ≥ 1
  readonly colSpan: number;                   // ≥ 1
}[];
```

- Sel di bawah/kanan anchor tetap ada dan tetap punya ID (referensi tidak putus).
- Renderer melewati (skip) sel yang tercakup merge.
- Validasi: span ≥ 1, tidak keluar batas tabel, tidak tumpang-tindih, anchor adalah
  sel yang ada di tabel yang sama.

### 5.2 Sumber sel (sudah ada, dipakai lebih luas)

`CellSource` tetap `INPUT | FORMULA | MAPPING`. “Atur formula berdasarkan cell” =
menjadikan `source.kind = "FORMULA"` untuk sel mana pun yang belum punya writer
aktif, dengan `referenceCellIds` hasil `references(parseFormula(expression))`.

### 5.3 Agregat (sudah ada)

Agregat (SUM) tetap didaftarkan lewat `EngineConfiguration.aggregates.memberCellIds`,
bukan dari posisi. Anggota baru harus dinyatakan eksplisit (sesuai §6 spesifikasi).

---

## 6. Command domain baru [U]

Semua memakai pola yang ada (`parseSnapshot` → perubahan → `captureSnapshot` +
`invalidateReviewContexts`), sehingga menghasilkan revisi baru dan tercatat di
boundary Save.

| Command | Ringkas | Guard penting |
|---|---|---|
| `addTable(snapshot, worksheetId, {label, afterTableId?})` | Tabel baru kosong | worksheet ada; label tidak kosong |
| `addRow(snapshot, tableId, {label, afterRowId?})` | Baris + sel untuk setiap kolom | ID unik; `rowOrder` diperbarui |
| `addColumn(snapshot, tableId, {label, afterColumnId?})` | Kolom + sel untuk setiap baris | ID unik; `columnOrder` diperbarui |
| `removeRow/removeColumn(snapshot, tableId, id)` | Hapus baris/kolom | **Tolak** bila sel-nya direferensikan formula/agregat/mapping/HPP, atau minta pelepasan eksplisit |
| `setRowLabel/setColumnLabel` | Ubah label | Label boleh sama; identitas by ID |
| `setCellFormula(snapshot, cellId, expression)` | Buat/ubah formula sel | Tolak bila sel adalah HPP manual atau target mapping aktif; validasi parse & referensi; **satu writer** |
| `clearCellSource(snapshot, cellId)` | Kembalikan ke `INPUT` `UNSET` | Tolak bila sel masih direferensikan (atau tandai `MISSING` eksplisit) |
| `mergeCells(snapshot, tableId, anchorCellId, {rowSpan, colSpan})` | Tambah merge | Validasi §5.1 |
| `unmergeCells(snapshot, mergeId)` | Hapus merge | — |
| `moveRow/moveColumn` | Ubah `order` | Hanya display (sudah ada `reorderTable`) |

Event yang dihasilkan: `STRUCTURE_CHANGED` (baris/kolom/tabel/merge) dan
`FORMULA_CHANGED` (formula) sesuai `ChangeEvent` yang sudah ada.

---

## 7. Renderer dinamis [U]

Ganti JSX hardcoded di `worksheet-surface.tsx` dengan renderer berbasis data:

1. Untuk setiap `WorksheetSnapshot` → render setiap `TableSnapshot`.
2. Kolom header dari `columns` mengikuti `columnOrder`.
3. Setiap baris dari `rows` mengikuti `rowOrder`; sel diambil dari `cells`
   (`rowId` × `columnId`).
4. Hitung matriks `skip` dari `merges`; render `rowSpan`/`colSpan` pada anchor.
5. Sel dirender:
   - `INPUT` → `<input class="sheet-input">` (existing behavior),
   - `FORMULA`/`MAPPING` → hasil engine (`run.results`) atau status (`EMPTY/ERROR/…`),
   - sel di luar scope profil aktif → tidak dihitung.
6. Pertahankan kelas gaya AHAS (`.ahs-sheet`, `.income-row`, `.cost-row`,
   `.profit-row`, `.category`, `.currency-cell`) sehingga tampilan tetap seperti
   `AHAS Sistem`; grup biaya memakai `rowSpan` pada kolom kategori.
7. Tombol aksi per baris/kolom (tambah baris di bawah, tambah kolom, merge pilihan)
   hanya muncul saat mode edit; tidak mengubah hasil.

**Penting:** baris/kolom yang tampil adalah hasil data, bukan konstanta. Bila nanti
template AHS default dipakai (D6), ia di-*seed* sebagai data ber-ID, bukan hardcode.

---

## 8. UI slimming: sheet-only [U]

- `page.tsx`/`ProcurementWorkspace` merender **hanya** `WorksheetSurface` + toolbar
  tipis (status, pemilih profil, tombol Simpan) — tanpa `fieldset` di bawahnya.
- Kontrol yang dipindah sesuai **D1** (mis. route `/pengaturan`) tetap memakai
  command/domain yang sama; tidak ada logika bisnis baru di UI.
- `.sheet-caption` boleh dipertahankan sebagai baris status, bukan blok kontrol.

---

## 9. Editor formula per sel [U]

- Klik sel → **formula bar** menampilkan `expression` (bila `FORMULA`) atau nilai input.
- Input ekspresi divalidasi dengan `parseFormula`/`references` (grammar terbatas:
  `+ − × /`, kurung, persen, `SUM`, referensi sel). Invalid → tidak di-commit.
- Tampilkan **dependency** (parent/dependent) dan **writer** (INPUT/FORMULA/MAPPING)
  sebagai provenance, memakai graph yang sudah ada (`compileGraph`).
- Commit lewat `setCellFormula`/`reviseFormula` (D5 menentukan `DRAFT`/`ACTIVE`).
- Tidak ada perhitungan di React; nilai dari engine.

---

## 10. Tahapan kerja (urutan aman)

Setiap tahap: diff kecil, test dijalankan, output dicantumkan. Satu tahap per PR.

| Tahap | Isi | Exit criteria |
|---|---|---|
| **F6.0** | Tetapkan **D1–D6**; tulis/ubah spesifikasi worksheet §6–§7 bila perlu | Keputusan tertulis; tidak ada asumsi tersisa |
| **F6.1** | Model `merges` + command struktural + test unit | Test command hijau; `npm run check` hijau; snapshot tetap immutable |
| **F6.2** | Renderer dinamis (data-driven + span) menggantikan hardcoded | Sheet identik secara fungsional untuk data template; sort/reorder tidak mengubah nilai |
| **F6.3** | Edit struktur di UI (tambah baris/kolom/tabel, merge/split) | T13 lulus: tambah/urut/hapus tidak menggeser referensi; hapus sel terpakai ditolak |
| **F6.4** | Editor formula per sel | T07/T15 lulus: formula valid menghitung dependent; siklus/missing/unit mismatch ditolak |
| **F6.5** | UI sheet-only; pindahkan fieldset ke `/pengaturan` (D1) | `/` hanya memuat `data-testid="procurement-sheet"`; fungsi lama tetap dapat diakses |
| **F6.6** | E2E + regresi | Suite browser lulus; tidak ada regresi Fase 5 |

---

## 11. Test & bukti

- **Unit (domain):** `addRow`/`addColumn`/`mergeCells`/`setCellFormula`/`removeRow`
  guard; agregat eksplisit; referensi tidak putus setelah reorder.
- **Renderer:** span dihitung benar; jumlah baris/kolom = data; sel di luar merge.
- **Engine:** full vs incremental identik pada snapshot dengan merge/row baru.
- **E2E:** buat tabel → tambah baris/kolom → merge → set formula → hitung → Save →
  reload; hapus sel terpakai ditolak dengan pesan.
- **Regresi:** `npm run check`, `npm run build`, dan (bila stack tersedia) `test:e2e`.

---

## 12. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Merge mengubah referensi/agregat tanpa sadar | Hasil berubah diam-diam | D2: merge tampilan-saja; referensi tetap by ID; test regresi |
| Menghapus fieldset menghilangkan akses pembuatan data | Fitur hilang | D1: pindahkan ke route/drawer sebelum menghapus |
| `appendField` (tabel 1×1) bentrok dengan tabel dinamis | Data ganda/inkonsisten | Migrasi: seed field lama ke baris tabel yang sesuai, atau pisahkan per-stage; jangan hapus histori |
| Sel baru tanpa unit memicu error palsu | `ERROR`/`INVALID` palsu | D3: unit `UNSET` ≠ dimensi salah; status dibedakan |
| Hardcode template AHS ditinggalkan tanpa seed | Gaya/struktur AHS hilang | D6: template ber-ID opsional |
| Editor formula menjadi tempat aritmetika | UI ≠ engine | Nilai hanya dari `FormulaEngine` |

---

## 13. Definisi selesai (ringkas)

- `/` hanya menampilkan worksheet; kontrol lama tetap tersedia (dipindah).
- Tabel/baris/kolom dapat ditambah/diubah dari UI, dengan merge/split.
- Formula per sel dapat diset/ubah lewat editor; invalid/siklus ditolak.
- Semua perubahan = revisi baru + `ChangeEvent`; tidak ada aritmetika di React.
- `npm run check` + `npm run build` (+ e2e bila tersedia) lulus; T07/T13/T14/T15
  relevan dibuktikan; tidak ada keputusan bisnis yang diisi tanpa persetujuan.

---

## 14. Pertanyaan terbuka untuk pemilik produk

1. **D1** — kontrol dipindah ke mana? Kontrol tetap terintegrasi langsung pada UI spreadsheet AHS, mengikuti pola interaksi Excel. Insert/delete row dan column, merge, copy-paste, undo/redo, serta pengeditan formula harus tersedia sesuai konteks sel atau struktur yang dipilih. Tidak perlu memindahkan kontrol ke halaman konfigurasi terpisah jika bisa dilakukan langsung di spreadsheet.
2. **D2** — merge tampilan-saja, atau memengaruhi agregat?Perubahan struktur harus memengaruhi formula, dependensi, subtotal, agregat, total biaya, margin, dan laba apabila cakupan atau dependensinya berubah. Sistem harus menghitung ulang seluruh formula terdampak seperti Excel. Merge yang hanya bersifat visual, seperti penggabungan sel judul, tidak boleh mengubah hasil perhitungan. Formula harus mengacu pada identitas elemen dan relasi yang stabil, bukan sekadar posisi baris atau kolom.


3. **D3** — unit/tipe baris-kolom baru wajib atau boleh `UNSET`?Baris atau kolom baru boleh dibuat dengan tipe/unit UNSET agar struktur AHS fleksibel. Namun, tipe dan unit harus divalidasi sebelum digunakan dalam perhitungan yang memerlukannya atau sebelum revisi difinalisasi. Formula engine harus mencegah operasi dengan tipe atau satuan yang tidak kompatibel, serta menampilkan kesalahan yang jelas alih-alih menghasilkan angka yang menyesatkan.

Ketiga keputusan ini harus diterapkan konsisten pada seluruh sistem AHS, bukan hanya pada UI, dan tetap mempertahankan histori revisi serta kemampuan mereproduksi hasil perhitungan sebelumnya.
4. **D4** — aktifkan jenis amount sekarang atau tetap tunda (K7)?
5. **D5** — formula baru langsung aktif atau draft? formula langsung aktif sama seperti ahas sistem
6. **D6** — workbook baru: kosong, atau template AHS ber-ID yang bisa diedit? template ahs juga bisa diedit

Jangan mulai F6.1 sebelum D1–D3 minimal terjawab, karena bentuk kontrak bergantung padanya.
