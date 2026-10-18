# Architecture

## Stack aktual

`apps/web/` adalah aplikasi Next.js 16.4.0 dengan React 19.3.0, TypeScript, ESLint, `node:test`, dan Playwright 1.64.1 untuk browser. Runtime: Node `>=22.12.0 <23`. Script verifikasi: `lint`, `typecheck`, `test`, `check`, `build`, dan `test:e2e`.

## Batas domain

Model domain Fase 2 menggunakan `WorkbookSnapshot` schema v2 yang memisahkan `project` dan `analysis`, dengan `analysisId` sebagai scope runtime/history. Analysis menyimpan candidate/vendor/offer state, revision head, profiles, mappings, dan review context. Repository in-memory mengelompokkan history per Analysis dan membuat revision baru saat Save/Restore.

Serialization, runtime validation, freshness, change summary, dan repository berada di `apps/web/src/domain/` serta `src/persistence/`. Engine Fase 3 menyediakan parser, evaluator decimal BigInt, graph dan full/incremental recalculation; repository PostgreSQL dan verifikasi Supabase Auth tersedia sejak Fase 4. Solver dan finalisasi bisnis belum tersedia.

## UI dan runtime Fase 5

Input vendor, harga, dan rumus dilakukan langsung di kolom workbook. Form daftar vendor, pembuatan penawaran, dan input komponen revisi terpisah dihapus atas instruksi pengguna 2026-10-17; pilihan revisi manual dan histori tetap tersedia. Pengisian nama vendor pada header menyiapkan sel penawaran pada draft yang sama.

Instruksi pengguna terbaru: pengujian perilaku dilakukan manual oleh pengguna;
script, fixture, dan runner test otomatis telah dihapus dari checkout. `check`
kini hanya lint dan typecheck. Bukti pengujian fase lama tetap catatan historis.
Pengeditan memakai formula bar berukuran normal seperti Excel; alamat/rumus
ditampilkan setelah sel dipilih, tanpa badge kode kecil di dalam sel.
Template memuat rumus bawaan; seluruh sel Evaluasi Vendor memakai editor nilai/rumus yang sama, termasuk nama, Harga Dasar, PPH, label, metadata, total, dan catatan. PPH default tetap manual/kosong, tetapi formula pengguna dipertahankan saat edit/load. `Harga Jual · Harga Dasar` AHS (`I11` INU / `I10` Solar) tetap input manual. PPN jual, Harga Include, dan Harga Jual Setelah Pajak mengikuti rumus template. HPP Harga Dasar AHS mengikuti Biaya Harga Dasar Konversi pada profil yang sama.
Worksheet lama dimaterialisasi menjadi sel stabil dan formula dalam graph yang
sama; preview tidak lagi membangun workbook sementara untuk setiap vendor pada
setiap ketikan. Formula referensi template dilengkapi tanpa menimpa input manual
yang sudah terisi, formula pengguna, atau snapshot historis.
Slot angka kosong pada template adalah input `UNSET`, bukan teks kosong; snapshot
lama dinormalisasi hanya pada draft aktif. Enter/keluar dari sel menyimpan input
dan menghitung ulang sekali, tanpa menghitung seluruh workbook per karakter.
Fokus formula bar saja tidak mengaktifkan pemilihan referensi. Nilai dan rumus Harga Dasar pada
setiap kolom vendor dapat diedit langsung; hasil rumus/dependensinya dicatat melalui engine pada revisi
baru tanpa otomatis mengganti revisi yang dipilih untuk Konversi. `recordVendorRevisions` memakai evaluator dan asumsi input kosong yang sama dengan preview, menyimpan rumus sebagai provenance, dan mempertahankan nilai `UNSET` pada input manual kosong. Referensi rusak/siklus tetap error. Lihat [audit editor Evaluasi Vendor](./EVALUASI_VENDOR_FORMULA_AUDIT.md) untuk cakupan dan batas verifikasi.

Integrasi Stitch 2026-10-16 memakai proyek `8591054839130643709`, layar
`0cbb4b678dc24fde816ae2403d23dd5a`: satu canvas dengan Evaluasi Vendor dan
Konversi Jagad di kiri, AHS di kanan, ringkasan dari hasil engine, tabel bergulir
per bagian pada mobile, dan cetak browser A4 landscape yang boleh berlanjut halaman.
Template dinamis schema v3 dirender dari stable ID, metadata sel, merge, dan
display order; toolbar formula/struktur berada di dalam canvas. Snapshot v2 tetap
memakai renderer kompatibilitas. Angka dan status persetujuan contoh Stitch tidak
diimpor. HPP Harga Dasar mengikuti Biaya Konversi dan profil memiliki pilihan revisi masing-masing.

Konfigurasi template dipulihkan dari `workbook.configuration`, termasuk ketika
belum ada Calculation Run. Mapping penawaran template membaca nilai dari revisi
immutable yang dipilih, sehingga negosiasi pada kolom tidak mengganti input
Konversi sampai pengguna memilih revisi baru. Solver INU otomatis memakai
formula aktif dan presisi decimal worksheet, memperluas bracket numerik lalu
mencari nilai terendah yang memenuhi `50 ≤ Profit MUE < 51` ketika sifat
nondecreasing dapat dibuktikan. Batas/step eksplisit tetap dapat dipakai dan
diperlukan untuk formula kustom yang tidak dapat dibuktikan sifatnya. Supplier
wajib lengkap; input numerik opsional kosong mengikuti preview asumsi nol,
sedangkan referensi rusak tetap ditolak. Solar Bawah tidak menjalankan solver.
Hanya toolbar worksheet yang sticky di area scroll; header tabel tidak sticky.

Migrasi `202610160001_dynamic_workbook_snapshots.sql` diperlukan agar storage
menerima schema v3 beserta objek workbook sambil tetap menerima v2 dan menjaga
validasi identitas. Migrasi ini diuji pada cluster sementara; penerapan cloud
tidak termasuk pekerjaan ini. Keterangan implementasi lama di bawah merupakan
baseline sebelum integrasi ini untuk bagian yang telah digantikan.

Halaman `/` memakai `src/ui/procurement-workspace.tsx`: login, Project/Analysis, vendor/offer/revisi, pilihan manual, worksheet input/formula, mapping eksplisit, Save/Restore, histori, dan konteks AHS. Pembuatan Project/Analysis berada di daftar proyek; histori dan kontrol legacy berada di canvas worksheet. Kebijakan internal preview tetap dipertahankan tanpa panel Pengaturan workbook; batas solver yang sudah tersimpan tetap dipakai tetapi tidak lagi dapat diubah dari UI.

Worksheet utama mengikuti susunan `docs/assets/image.png`: vendor di kiri atas, konversi di kiri bawah, AHS di kanan. Formula dan aksi struktur berada di toolbar canvas; panel Pengaturan workbook telah dihapus. `WorksheetSurface` mempertahankan slot visual acuan; tabel tambahan dirender dari stable ID dan display order melalui `buildSheetGrid`. Ini belum berarti seluruh template acuan berasal dari data dinamis.

`structure.ts` menyediakan penambahan/penghapusan baris/kolom, tabel, formula per sel, serta merge/split tampilan. Merge menyimpan anchor dan span, mempertahankan identitas/nilai semua sel tertutup; validator menolak anchor hilang, overlap, batas span dan identitas ganda. Snapshot schema v2 lama tanpa `merges` dibaca sebagai array kosong. Formula HPP dari Biaya Konversi dan sumber/target mapping dilindungi dari perubahan writer; formula bersiklus ditolak. Editor menjaga anggota agregat/dependensi pilihan dari penghapusan, sedangkan metadata unit sel yang dihapus dibuang dari konfigurasi preview. Sel baru tetap memerlukan satuan eksplisit agar kalkulasinya sah.

`/api/session` memproksikan password login, refresh, validasi sesi dan logout ke Auth REST resmi. Token disimpan pada cookie HttpOnly/SameSite=Strict; Secure pada HTTPS. Mutation berbasis cookie memerlukan Origin yang cocok dengan HTTP Host dan protokol. `/api/workbook` tetap mendukung Bearer API yang ada dan sekarang menerima sesi cookie browser. Identitas/otorisasi repository tetap berasal dari Auth server.

UI memanggil command domain dan FormulaEngine untuk preview; tidak menghitung uang melalui aritmetika React. Save menyimpan snapshot terlebih dahulu, kemudian CALCULATE menyimpan manifest. Keduanya bukan satu transaksi: kegagalan kalkulasi tidak membatalkan snapshot yang sudah tersimpan. Hasil historis dipertahankan; run pada revision lama ditandai historis/STALE. Konfigurasi preview dipulihkan dari manifest tersimpan yang sesuai snapshot/policy/inventory; konfigurasi yang belum pernah berhasil dikirim ke CALCULATE belum durable.

Draft berada di memori browser, dengan peringatan sebelum meninggalkan halaman. Kegagalan Save dan login ulang pengguna yang sama mempertahankan draft; login pengguna lain membersihkannya. Pergantian sesi melalui UI disiarkan lintas tab untuk menyembunyikan workspace akun sebelumnya. Belum ada pemulihan draft setelah browser crash.

Playwright menjalankan production build di loopback, Supabase Auth native resmi dan cluster PostgreSQL 17 sementara. Target/kredensial dihasilkan harness; `.env` cloud tidak menjadi target uji. Lihat `PHASE5_VERIFICATION.md` untuk bukti dan batas penerimaan.

## Kontrak perubahan

Perubahan harus melewati command/validation domain, mempertahankan stable ID, dan tidak memutasi snapshot lama. Event disimpan pada boundary Save/Restore sebagai ringkasan perubahan penting, bukan event-sourcing atau setiap ketikan draft.

## Sumber otoritatif

Aturan bisnis berasal dari PRD/spesifikasi dan invariant pengguna, bukan asumsi UI. Lihat [SOURCE_INDEX.md](./SOURCE_INDEX.md) untuk artefak yang diaudit.
