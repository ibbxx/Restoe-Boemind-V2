# Audit dan refactor persistence current-only

Tanggal: 2026-10-19. Status: implementasi lokal selesai, migration baru belum diterapkan ke Supabase cloud. Tidak ada perubahan atau penghapusan data cloud pada pekerjaan ini.

## Hasil audit

- Save runtime sebelumnya sudah memakai UPSERT satu current workbook, tetapi payload/domain/UI masih membawa offerRevisions, nomor revisi, token versi formula/mapping, review context, dan field arsip kosong.
- Konfigurasi engine sebelumnya disimpan dalam snapshot dinamis dan kolom configuration; nilai vendor disalin ke cell dan record offer. Metadata Project/Analysis juga disalin ke snapshot.
- Audit katalog cloud baca-saja pada project yang dikonfirmasi dari `.env` menemukan 15 tabel procurement, dua fungsi (current_actor_id dan reject_history_mutation), delapan trigger immutable_history, policy owner dan foreign key histori. Tidak menemukan RPC histori tambahan di schema procurement.
- Ledger cloud berisi 202610140001, 20261015023734, 20261019035326; migration baru 20261019071911 tidak tercatat. File SQL lama tetap dipertahankan sebagai rantai deployment yang sudah ada, bukan dependensi runtime.

## Bentuk penyimpanan final

| Tabel | Peran |
|---|---|
| projects | ID, owner dan nama Project |
| analyses | ID, Project, owner dan nama Analysis; banyak Analysis per Project |
| current_workbooks | Satu row per Analysis, satu data JSONB normalized, versi teknis, metadata simpan, mutation ID/signature terakhir |

`data` memakai format `{ schemaVersion: 1, state, configuration }`. Metadata Project/Analysis dimaterialisasi dari join tabel indeks. Konfigurasi disimpan satu kali di data.configuration. Input manual vendor disimpan dalam offers[].values; source sel tersimpan memakai OFFER_VALUE dengan offerId/valueId. Adapter mematerialisasikan INPUT untuk kontrak editor dan engine yang ada. Formula vendor disimpan sebagai formula aktif, tanpa salinan hasil hitung atau ekspresi dalam nilai offer. Duplikasi kecil berupa nama/label identitas tidak diperlakukan sebagai arsip workbook.

Domain memakai selectedOfferId serta selection offerId per profil. Offer, formula dan mapping mempunyai satu definisi aktif; revisionNumber, ID revisi offer, ID versi formula/mapping, changeEventId, reviewContext, contextRunId dan calculationRunRefs telah dilepas. Nama tipe WorkbookSnapshot/ID draft tetap untuk representasi immutable kondisi di memori dan pemeriksaan respons/preview yang tertinggal; tidak mempunyai tabel atau koleksi arsip.

Preview EngineRun dan konfigurasi graph untuk incremental recalculation hidup di memori. Tidak disimpan ke database. WeakSet identitas preview tidak menahan arsip. Formula, referensi stable cell ID, graph/unit validation, solver INU, presisi, konversi, vendor manual, serta input Harga Jual/HPP dipertahankan. Nama vendor berbasis formula dibaca dari preview pada UI tanpa menyimpan hasil formula sebagai nilai offer.

Save memvalidasi payload dan graph, mengunci Project/Analysis, lalu menyimpan metadata/data dalam satu transaksi. Row memakai primary key analysis_id; Save berulang tidak menambah row logis. expectedVersion tetap menolak stale save; hanya mutation ID/signature terakhir yang diingat. Retry terakhir identik tidak menulis ulang; payload berbeda ditolak. Tidak ada ledger retry historis.

## Tabel dan objek yang dihapus migration

Migration `apps/web/supabase/migrations/20261019071911_current_only_procurement.sql` menghapus:

- workbook_snapshots
- revisions
- change_events
- revision_mutations
- offer_revisions
- analysis_heads
- calculation_runs
- latest_calculation_runs
- formula_versions
- mapping_versions
- offers
- vendors

Vendor/offer aktif tetap ada dalam payload; penghapusan dua tabel terakhir menghilangkan storage duplikat. Trigger, foreign key, index, policy dan grants milik tabel yang dihapus turut hilang. Fungsi reject_history_mutation dihapus. Fungsi current_actor_id tetap dipakai untuk identitas terverifikasi; tidak menambah RPC atau trigger bisnis.

Tiga tabel final memakai ENABLE/FORCE RLS dan total sembilan policy owner SELECT/INSERT/UPDATE, termasuk USING dan WITH CHECK. Hak runtime tetap SELECT/INSERT dan UPDATE kolom yang diperlukan, tanpa DELETE/TRUNCATE/administrasi. Token user tetap diverifikasi server sebelum claims transaksi diisi. Foreign key final mengikat analyses ke projects dan current_workbooks ke analyses beserta Project/owner. Index project/owner ditambahkan untuk daftar Analysis.

## File berubah

File baru:

- apps/web/src/persistence/workbook-data.ts — format storage normalized dan materialisasi current view.
- apps/web/supabase/migrations/20261019071911_current_only_procurement.sql — konversi current payload dan penghapusan arsip.
- apps/web/tests/current-persistence.test.ts — regresi domain/API/PostgreSQL lokal.
- docs/agent-context/PERSISTENCE_CURRENT_ONLY_AUDIT.md — laporan ini.

File runtime diperbarui:

- apps/web/src/domain/contracts.ts
- apps/web/src/domain/validation.ts
- apps/web/src/domain/dynamic-validation.ts
- apps/web/src/domain/ids.ts
- apps/web/src/domain/current-workbook.ts
- apps/web/src/domain/current-offers.ts
- apps/web/src/domain/commands.ts
- apps/web/src/domain/workflow.ts
- apps/web/src/domain/dynamic-workflow.ts
- apps/web/src/domain/legacy-sheet.ts
- apps/web/src/domain/procurement-template.ts
- apps/web/src/domain/ahs-volume.ts
- apps/web/src/domain/structure.ts
- apps/web/src/domain/vendor-components.ts
- apps/web/src/engine/contracts.ts
- apps/web/src/engine/graph.ts
- apps/web/src/engine/evaluator.ts
- apps/web/src/engine/formula-engine.ts
- apps/web/src/engine/inu-solver.ts
- apps/web/src/persistence/postgres-workbook-repository.ts
- apps/web/src/persistence/runtime-role.ts
- apps/web/src/ui/procurement-workspace.tsx
- apps/web/src/ui/worksheet-surface.tsx

Script apps/web/scripts/migrate-current-workbooks.ts dan script package migrate:current-workbooks dihapus karena membaca arsip lama. Script tersebut dapat dipulihkan dari Git, tetapi tidak kompatibel dengan schema final. Tidak ada dependency baru atau perubahan lockfile.

Dokumentasi diperbarui: root AGENTS.md, apps/web/README.md, README engine/persistence, catatan baseline CLOUD_VERIFICATION.md, serta docs/agent-context/{ARCHITECTURE,BUSINESS_RULES,CURRENT_WORKBOOK_MIGRATION,OPEN_DECISIONS,PHASE_STATUS,SOURCE_INDEX}.md. Instruksi tes diselaraskan dengan permintaan terbaru pengguna.

Perubahan yang sudah ada sebelum tugas pada browser-session.ts, loading-indicator.tsx dan workbook-client.ts dipertahankan tanpa modifikasi tambahan. Procurement-workspace.tsx dan ARCHITECTURE.md juga mempunyai perubahan masuk sebelumnya; bagian itu dipertahankan saat menerapkan perubahan persistence. apps/web/AGENTS.md, workbook sumber, source-template.ts, PRD dan expected value tidak diubah. Route handler API dan verifikasi Auth tidak perlu diubah: runtime sudah hanya mendukung SAVE/current/projects/analyses; audit dan tes memastikan route histori tidak tersedia.

## Hasil verifikasi

Perintah:

```sh
cd apps/web
node --experimental-transform-types --test tests/current-persistence.test.ts
npm run check
npm run build
git diff --check
```

Hasil lokal: **11 PASS, 0 FAIL, 0 SKIP** (sepuluh skenario dan satu parent test); lint/typecheck, production build dan diff check berhasil. Runtime Node 22 memerlukan flag transform-types karena repository memakai TypeScript constructor parameter properties.

Harness membuat dan menghapus cluster PostgreSQL 17 sementara pada loopback, membuat schema/Auth shim serta login aplikasi NOINHERIT yang memakai role runtime, lalu menerapkan rantai SQL lokal. Data seluruhnya sintetis. `.env`, Supabase Auth cloud dan data produksi tidak digunakan oleh tes.

Yang dibuktikan:

1. Migration menolak Analysis tanpa current data dan rollback mempertahankan schema/arsip.
2. Konversi current data layout v2/v3 mempertahankan cell, formula, ID, pilihan profil, nilai, konfigurasi dan hasil/provisional engine sebelum/sesudah migration. Arsip sintetis workbook/revision/head juga benar-benar terisi sebelum dihapus.
3. Hasil schema hanya tiga tabel, sembilan policy, nol trigger aplikasi dan satu fungsi identitas.
4. Sepuluh Save pada Analysis yang sama tetap satu row, reload mengembalikan input terakhir. Retry identik tidak menggandakan data; ID retry dengan payload berbeda dan stale save ditolak.
5. Satu Project mempunyai beberapa Analysis independen.
6. Dua Save bersamaan dari versi yang sama menghasilkan tepat satu sukses dan satu konflik.
7. Formula manual PPH tetap tersimpan dan kalkulasi 25000 × 0,02 = 500 mengalir melalui mapping vendor ke Konversi. Nama vendor berbasis formula tetap TEXT; hasil incremental sama dengan full calculation.
8. Role aplikasi tidak membaca/mengubah data owner lain; payload invalid tidak mengubah data tersimpan.
9. Input vendor tersimpan sekali dalam offer; cell memakai reference. Reference yang putus ditolak decoder.
10. Handler HTTP SAVE/current memakai repository nyata; endpoint histori dan akses tanpa autentikasi ditolak.

Pencarian source runtime tidak menemukan offerRevisions, offer-revision, selectedOfferRevisionId, revisionNumber, changeEventId, reviewContext, calculationRunRefs, atau tabel histori. Nama tersebut hanya diperlukan dalam SQL upgrade, fixture konversi dan bukti baseline. API window.history hanya mengatur URL navigasi, tidak menyimpan data bisnis.

## Penerapan dan batas

**Supabase cloud: belum diterapkan.** Audit katalog dan ledger hanya baca-saja. Cloud masih memakai kolom snapshot/configuration lama dan arsip tetap ada. Tidak mengklaim tes Save cloud atau penghapusan cloud berhasil.

Untuk cutover operator: hentikan writer/aplikasi lama, pastikan setiap Analysis mempunyai current data, jalankan migration baru secara transaksional pada target yang benar, periksa tiga tabel/RLS/current payload, lalu jalankan aplikasi baru. Konversi current data dan penghapusan tabel berada dalam transaksi yang sama; kegagalan membatalkan semuanya. Tidak ada auto-migration, fallback membaca arsip, down-migration, atau perubahan kredensial. Migration lama tidak ditulis ulang; operator perlu mencocokkan ledger dengan file migration sebelum menggunakan CLI push.

Kode baru tidak kompatibel dengan schema cloud lama: runtime mengembalikan STORAGE_UPGRADE_REQUIRED sampai migration diterapkan. Penghapusan histori fisik melalui migration tidak dapat dibatalkan tanpa sumber pemulihan terpisah. PostgreSQL tetap menghasilkan versi row internal untuk UPDATE/MVCC; ini bukan histori aplikasi dan tidak menjamin ukuran fisik tidak tumbuh.

Browser/visual, login Supabase nyata, seluruh expected value Excel/EV-005, serta ukuran/latensi cloud belum diuji. Handler tes memakai authenticator sintetis; RLS/repository/transaksi diuji dengan PostgreSQL nyata dan login terbatas. Tidak ada klaim kesetaraan seluruh angka bisnis dengan Excel atau deployment cloud.
