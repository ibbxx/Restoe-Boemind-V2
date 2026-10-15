# Architecture

## Stack aktual

`apps/web/` adalah aplikasi Next.js 16.4.0 dengan React 19.3.0, TypeScript, ESLint, `node:test`, dan Playwright 1.64.1 untuk browser. Runtime: Node `>=22.12.0 <23`. Script verifikasi: `lint`, `typecheck`, `test`, `check`, `build`, dan `test:e2e`.

## Batas domain

Model domain Fase 2 menggunakan `WorkbookSnapshot` schema v2 yang memisahkan `project` dan `analysis`, dengan `analysisId` sebagai scope runtime/history. Analysis menyimpan candidate/vendor/offer state, revision head, profiles, mappings, dan review context. Repository in-memory mengelompokkan history per Analysis dan membuat revision baru saat Save/Restore.

Serialization, runtime validation, freshness, change summary, dan repository berada di `apps/web/src/domain/` serta `src/persistence/`. Engine Fase 3 menyediakan parser, evaluator decimal BigInt, graph dan full/incremental recalculation; repository PostgreSQL dan verifikasi Supabase Auth tersedia sejak Fase 4. Solver dan finalisasi bisnis belum tersedia.

## UI dan runtime Fase 5

Halaman `/` memakai `src/ui/procurement-workspace.tsx`: login, Project/Analysis, vendor/offer/revisi, pilihan manual, worksheet input/formula, konfigurasi satuan/pembulatan preview, mapping eksplisit, Save/Restore, histori, dan konteks HPP. Workbook baru kosong; HPP tiap profil adalah INPUT manual tanpa angka contoh.

`/api/session` memproksikan password login, refresh, validasi sesi dan logout ke Auth REST resmi. Token disimpan pada cookie HttpOnly/SameSite=Strict; Secure pada HTTPS. Mutation berbasis cookie memerlukan Origin yang cocok dengan HTTP Host dan protokol. `/api/workbook` tetap mendukung Bearer API yang ada dan sekarang menerima sesi cookie browser. Identitas/otorisasi repository tetap berasal dari Auth server.

UI memanggil command domain dan FormulaEngine untuk preview; tidak menghitung uang melalui aritmetika React. Save menyimpan snapshot terlebih dahulu, kemudian CALCULATE menyimpan manifest. Keduanya bukan satu transaksi: kegagalan kalkulasi tidak membatalkan snapshot yang sudah tersimpan. Hasil historis dipertahankan; run pada revision lama ditandai historis/STALE. Konfigurasi preview dipulihkan dari manifest tersimpan yang sesuai snapshot/policy/inventory; konfigurasi yang belum pernah berhasil dikirim ke CALCULATE belum durable.

Draft berada di memori browser, dengan peringatan sebelum meninggalkan halaman. Kegagalan Save dan login ulang pengguna yang sama mempertahankan draft; login pengguna lain membersihkannya. Pergantian sesi melalui UI disiarkan lintas tab untuk menyembunyikan workspace akun sebelumnya. Belum ada pemulihan draft setelah browser crash.

Playwright menjalankan production build di loopback, Supabase Auth native resmi dan cluster PostgreSQL 17 sementara. Target/kredensial dihasilkan harness; `.env` cloud tidak menjadi target uji. Lihat `PHASE5_VERIFICATION.md` untuk bukti dan batas penerimaan.

## Kontrak perubahan

Perubahan harus melewati command/validation domain, mempertahankan stable ID, dan tidak memutasi snapshot lama. Event disimpan pada boundary Save/Restore sebagai ringkasan perubahan penting, bukan event-sourcing atau setiap ketikan draft.

## Sumber otoritatif

Aturan bisnis berasal dari PRD/spesifikasi dan invariant pengguna, bukan asumsi UI. Lihat [SOURCE_INDEX.md](./SOURCE_INDEX.md) untuk artefak yang diaudit.
