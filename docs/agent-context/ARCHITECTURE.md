# Architecture

## Cetak seluruh vendor — 2026-10-19

Tombol cetak menyalin seluruh kolom vendor aktif Evaluasi Vendor sesuai urutan tampil, maksimal tiga vendor pada setiap halaman A4 landscape. Metadata proyek, uraian, hasil formula, total, dan catatan ikut dicetak; Konversi dan AHS dari vendor/profil yang dipilih diulang pada setiap halaman. Kolom yang tidak ditemukan menolak cetak, tanpa melewati vendor secara diam-diam. Salinan DOM dibersihkan melalui afterprint (termasuk pembatalan dialog) atau saat gagal. Worksheet, pilihan vendor, formula, dan persistence tidak berubah.

Cetak langsung browser juga tidak menyembunyikan vendor yang tidak dipilih, tetapi pembagian per tiga vendor disiapkan oleh tombol cetak aplikasi. Konten vertikal panjang tetap diperkecil agar muat; keterbacaan, pagination fisik, pembatalan dialog dan cetak ulang perlu dicek manual di browser. Tes table-only mencakup 1/3/4/7/10/100 vendor, urutan, sel kosong, hasil formula/catatan, merge, penolakan kolom tidak valid, serta sumber yang tidak berubah.

## Current-only tanpa arsip — refactor 2026-10-19

Bagian ini menggantikan seluruh kontrak histori/legacy storage pada catatan lama di bawah. Runtime memakai tiga tabel: projects, analyses, current_workbooks. Setiap Analysis mempunyai satu row `data jsonb`; metadata Project/Analysis berada pada tabel indeks, konfigurasi disimpan satu kali, dan nilai manual vendor canonical berada pada offer. Cell storage mereferensikan offer/value; adapter mematerialisasi INPUT untuk editor/engine. Formula dan mapping hanya definisi aktif dengan stable ID; selection memakai offerId. Tidak ada offerRevisions, reviewContext, calculationRunRefs, atau ID versi formula/mapping di domain aktif.

`20261019071911_current_only_procurement.sql` mengonversi current data dan menghapus dua belas tabel arsip/duplikat beserta dependensinya. Migration baru belum diterapkan ke cloud. Source SQL migration lama dipertahankan untuk rantai deployment; script backfill lama dihapus. Preview dan incremental cache tetap transient. Guard konflik/retry, RLS, Auth, TLS dan transaksi tetap berlaku. Laporan file, tabel, audit cloud baca-saja dan tes lokal ada di [PERSISTENCE_CURRENT_ONLY_AUDIT.md](./PERSISTENCE_CURRENT_ONLY_AUDIT.md).

## Pemeriksaan sesi dan logo loading — 2026-10-19

GET `/api/session` mengembalikan `{ actorId: null }` dengan HTTP 200 ketika kedua cookie sesi kosong, atau ketika access token ditolak dan tidak ada refresh cookie. Cookie tidak valid dibersihkan; gangguan Auth tetap HTTP 503. Jika refresh cookie tersedia, kegagalan access token tetap HTTP 401 agar client memakai POST REFRESH dengan pemeriksaan origin yang ada. Login salah serta akses workbook tanpa autentikasi tetap ditolak; status anonim endpoint sesi bukan akses data.

Client menggabungkan hanya GET sesi dan POST refresh yang sedang berjalan, tanpa cache hasil sesi setelah selesai. Perubahan akun, logout, sesi lintas tab, atau sesi berakhir membatalkan request lama dengan AbortController; hasil/pesan lama diabaikan. Workspace menerima actorId nullable, berhenti sebelum meminta proyek saat anonim, dan mempertahankan draft saat perlu login ulang. Startup memakai pemeriksaan epoch dan cleanup komponen tanpa mematikan Strict Mode. Gambar fallback logo memakai loading eager; renderer Canvas dan siklus animasi tetap sama.

Typecheck, lint berkas terkait, serta git diff --check selesai tanpa error. Tidak menjalankan pengujian aplikasi/browser otomatis. Penerimaan manual: tab tanpa cookie hanya melakukan satu GET sesi 200 tanpa POST refresh/proyek; sesi valid membuka proyek; access token kedaluwarsa dengan refresh valid pulih; refresh ditolak menampilkan login tanpa membuang draft; logout/pergantian akun/lintas tab tidak menerima respons lama; warning lazy LCP pada logo tidak muncul lagi. Kecepatan dan kelancaran visual belum diukur.

## Penyimpanan terbaru — keputusan 2026-10-19

Bagian ini menggantikan penjelasan histori/repository/CALCULATE pada baseline lama di bawah. Runtime sekarang memakai `PostgresWorkbookRepository` dan `procurement.current_workbooks`: satu snapshot, konfigurasi engine lengkap (termasuk legacy v2), token versi, metadata simpan, serta mutation ID/signature terakhir per Analysis. SAVE memvalidasi snapshot/configuration, memakai transaksi dan lock Project/Analysis, menolak versi tertinggal, serta memperbarui satu baris. Signature SHA-256 menghindari penggandaan payload sebagai metadata retry. Retry yang sudah tertinggal mendapat konflik; respons workspace/sesi lama diabaikan. Role runtime hanya mengakses projects, analyses, dan current_workbooks dengan RLS/claim guard yang tetap diperiksa setiap transaksi.

GET workbook mengambil satu kondisi terbaru tanpa histori/run. Hasil FormulaEngine hanya berada di memori browser untuk preview/cetak dan incremental recalculation; engine tidak menampung runHistory atau menerbitkan arsip. Vendor mempertahankan satu set nilai aktif, tanpa pembuatan versi historis. Nama field legacy offerRevisions, revisionNumber, reviewContext, dan calculationRunRefs tetap dapat dibaca untuk kompatibilitas schema v2/v3; yang tersimpan hanya nilai vendor aktif dengan reviewContext/contextRunId null dan calculationRunRefs kosong. ID teknis formula/mapping tetap dipakai untuk validasi/cache.

Migrasi cloud `20261019035326_current_workbooks_with_latest_data` telah diterapkan dengan DDL dan backfill satu transaksi melalui koneksi operator MCP yang diotorisasi pengguna. Satu Analysis berhasil dipindahkan, 268 sel dan seluruh formula identik dengan head sumber, 30 revisi serta 21 run lama tetap utuh. Konfigurasi aktif memakai 18 desimal HALF_UP; current tidak mempunyai referensi run historis. File skema lokal diselaraskan dengan versi cloud; data finansial backfill tidak dimasukkan ke Git. Perintah backfill operator terpisah tetap tersedia untuk target lain. Arsip lama tidak dihapus. Lihat [CURRENT_WORKBOOK_MIGRATION.md](./CURRENT_WORKBOOK_MIGRATION.md) untuk urutan cutover dan verifikasi manual. Pengujian aplikasi dilakukan manual oleh pengguna.

## Stack aktual

`apps/web/` adalah aplikasi Next.js 16.4.0 dengan React 19.3.0, TypeScript, ESLint, `node:test`, dan Playwright 1.64.1 untuk browser. Runtime: Node `>=22.12.0 <23`. Script verifikasi: `lint`, `typecheck`, `test`, `check`, `build`, dan `test:e2e`.

## Batas domain

Model domain Fase 2 menggunakan `WorkbookSnapshot` schema v2 yang memisahkan `project` dan `analysis`, dengan `analysisId` sebagai scope runtime/history. Analysis menyimpan candidate/vendor/offer state, revision head, profiles, mappings, dan review context. Repository in-memory mengelompokkan history per Analysis dan membuat revision baru saat Save/Restore.

Serialization, runtime validation, freshness, change summary, dan repository berada di `apps/web/src/domain/` serta `src/persistence/`. Engine Fase 3 menyediakan parser, evaluator decimal BigInt, graph dan full/incremental recalculation; repository PostgreSQL dan verifikasi Supabase Auth tersedia sejak Fase 4. Solver dan finalisasi bisnis belum tersedia.

## UI dan runtime Fase 5

Perbaikan presisi INU/AHS 2026-10-19: `FormulaEngine` memakai versi `phase3-grammar2-fixed-decimal4-inu-cent-precision18-provisional` dan hanya meneruskan previous run dari versi yang sama ke cache solver. `domain/calculation-policy.ts` menetapkan kebijakan operasional 18 desimal HALF_UP EVERY_OPERATION dan policy UUID tetap untuk versi tersebut. `prepareCalculationPolicy` menyiapkan pasangan snapshot/configuration secara idempoten sebelum transformasi numerik, pencatatan vendor, dan preview pada load/edit. Snapshot v3 menyimpan konfigurasi; snapshot v2 menyimpan policy UUID, sehingga fallback 18 desimal tetap berlaku bila CALCULATE belum berhasil. Konfigurasi run lama yang cocok inventaris hanya dipakai memulihkan metadata unit/agregat sebelum policy dinaikkan; nilai hasil lama tidak dipakai untuk preview baru. Perubahan policy menandai draft berubah dan menginvalidasi konteks review melalui domain. Konfigurasi draft disimpan serentak pada ref dan state UI, sehingga commit input saat blur sebelum Simpan tidak mengirim snapshot terbaru dengan konfigurasi dari render sebelumnya. SAVE dan CALCULATE memakai policy yang sama, sementara manifest dan snapshot historis tetap utuh.

`operationalGraph` memakai langkah otomatis `decimal.parse("0.01")`, termasuk saat memperluas bracket positif/negatif; kandidat dan batas target Profit MUE diperiksa dengan nilai internal 18 desimal. Konfigurasi engine dengan skala di bawah dua atau batas/step solver dengan pecahan bermakna lebih dari dua digit ditolak saat perhitungan, sehingga parser snapshot historis tetap kompatibel. Formatter bersama memakai DecimalArithmetic HALF_UP tanpa konversi uang melalui Number; hasil tampilan tidak dipakai sebagai input engine. Biaya solver dan HPP Harga Dasar INU ditampilkan dua desimal pada canvas/cetak. API dan schema database tetap memakai kontrak yang ada. Pembandingan Excel/manual dan perilaku Simpan/buka ulang belum diverifikasi pada perubahan ini.

Indikator loading 2026-10-19 memakai Canvas 2D dengan proyeksi globe bertekstur dan kedalaman per piksel untuk dua sayap yang bergerak independen. Modul renderer dimuat dinamis; tekstur WebP 512×256 dan geometri sayap tersedia lokal. Tidak ada dependency runtime tambahan, video, atau WebGL untuk loader aplikasi. Render memakai buffer 256×256, rasterisasi segitiga bertahap, dan target maksimum 60 FPS melalui requestAnimationFrame. Siklus penuh menjadi 8 detik (1,5× lebih cepat): globe 8 detik, merah sekitar 2,7 detik, dan biru 4 detik. Render berhenti ketika proses selesai atau tab tersembunyi, menghormati reduced motion, dan dibersihkan saat unmount. Indikator tunggal tampil di tengah viewport dengan latar transparan, tanpa kartu, bingkai, overlay warna, atau bayangan lantai saat operasi workspace, Save, dan persiapan cetak. Backdrop blur 6 px mengaburkan aplikasi di belakangnya, sementara animasi dan teks loading tetap tajam; tombol Simpan menampilkan `Menyimpan…` selama SAVE. CALCULATE tetap memakai status terpisah dan tidak memperpanjang status sibuk Save. Typecheck selesai; lint pada file terkait tidak memiliki error, dengan satu warning efek load workspace yang sudah ada. Pemeriksaan visual/perilaku dan performa perangkat dilakukan manual oleh pengguna.

Optimasi Simpan 2026-10-19: repository PostgreSQL memakai transisi revisi bersama dengan repository in-memory, membaca head dan bukti versi/konteks yang dirujuk tanpa memuat histori snapshot penuh saat SAVE/RESTORE. Persistensi vendor/offer/versi memakai bulk SQL dengan pemeriksaan ulang payload dan ownership dalam transaksi yang sama. UI mengakhiri status sibuk setelah SAVE; CALCULATE otomatis memakai antrean per Analysis, mengganti pekerjaan tertunda dengan revisi terbaru, dan mengabaikan respons sesi/workspace/revisi lama. Histori snapshot pembanding diperbarui lokal dari hasil Save. Header Server-Timing memuat durasi auth, validation, persistence, calculation bila tersedia, dan total handler; tidak memuat isi workbook atau kredensial. Pengujian perilaku dan penulisan database belum dijalankan pada perubahan ini.

Pembaruan 2026-10-18: mapping `vendor-live:<offerId>:<sourceCellId>` membaca sel aktif Evaluasi Vendor melalui graph, termasuk hasil formula dan error dependensinya. `vendorComponents` menyediakan identitas komponen dan sel uraian bersama bagi renderer Konversi dan pemetaan baris tambahan. `recordVendorRevisions` memperbarui pointer vendor yang sudah dipilih pada kedua profil dan memangkas revisi draft yang tidak diperlukan; referensi run/review historis tetap dipertahankan. Alur load/edit mematerialisasi data vendor terkini terlebih dahulu, kemudian membangun mapping untuk setiap profil yang telah memilih vendor. Uraian dan nilai laporan cetak berasal dari renderer yang sama. Ini menggantikan penjelasan penguncian revisi vendor dalam catatan integrasi lama di bawah.

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
