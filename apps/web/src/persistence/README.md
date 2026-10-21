# Persistence: kondisi aktif Analysis

Satu Project mempunyai banyak Analysis. `PostgresWorkbookRepository` menyimpan tepat satu row `current_workbooks` per Analysis dengan primary key `analysis_id`. Semua Save baru menggunakan UPSERT; tidak membuat arsip.

Tabel aktif hanya `projects`, `analyses`, dan `current_workbooks`. Metadata nama Project/Analysis berada pada dua tabel pertama; `current_workbooks.data` menyimpan satu payload normalized dengan worksheet, input, formula aktif, mapping aktif, pilihan offer per profil, dan satu konfigurasi engine. Nilai vendor manual berada pada `offers[].values`; cell storage memakai `OFFER_VALUE { offerId, valueId }`. Adapter mematerialisasi INPUT untuk editor dan engine tanpa menyimpan salinan kedua. Formula vendor tetap definisi formula aktif, tanpa menyimpan hasil evaluasi atau salinan ekspresi sebagai nilai offer.

Tidak ada revisions, events, offer revisions, run history, head pointer, arsip workbook, tabel formula/mapping tambahan, atau ledger retry. `WorkbookSnapshot` adalah nama tipe immutable untuk kondisi di memori, bukan arsip database. Preview engine termasuk input/configuration untuk incremental recalculation hanya hidup di memori, tidak dipersistensikan.

## API

- GET `/api/workbook?view=projects`
- GET `/api/workbook?view=analyses&projectId=<UUID>`
- GET `/api/workbook?analysisId=<UUID>` atau `view=current`
- POST `/api/workbook`: `{ operation: "SAVE", request: { snapshot, configuration, expectedVersion, mutationId } }`

Daftar Analysis sekarang mengembalikan `{ items, total, periods, nextCursor, previousCursor }`. Ukuran halaman default 25, maksimum 100 (`limit`). Gunakan `after=<UUID>` atau `before=<UUID>`, tidak keduanya. Urutan tetap UUID ascending; navigasi mundur mengambil halaman sebelumnya dalam urutan yang sama. Filter `query`, `status`, dan `period` dijalankan pada server sebelum pagination; `period=NONE` memilih tanggal kosong/tidak valid/formula. Filter baru menghapus cursor di UI. `analysisId` dapat memfokuskan satu metadata Analysis tanpa bergantung pada halaman atau filter aktif.

Daftar hanya membaca metadata dan `current_workbooks.analysis_date`, bukan `data`. Kolom tanggal adalah generated STORED dari JSONB melalui fungsi invoker immutable. Pemilihan tanggal pertama tetap sama dengan implementasi sebelumnya; tahun kabisat, tanggal tidak valid, kedua format workbook dan kedua profil diuji. Tidak ada tanggal kedua yang dapat diedit atau tertinggal dari workbook. Total dan pilihan periode masih memindai metadata Project; ini bukan klaim pagination berbiaya konstan untuk seluruh query.

GET current mengembalikan `{ snapshot, configuration, version, savedAt, savedBy }` atau null. Wire format adalah tampilan workbook yang dimaterialisasi; penyimpanan `data` dinormalisasi oleh `workbook-data.ts`. Field domain `selectedOfferId` dan `workbook.selections` merujuk offer aktif. Tidak menerima payload offer-revision lama atau RESTORE/CALCULATE/history/replay/runs.

Sukses Save: `{ status: "SAVED", workbook }`. Versi tertinggal: HTTP 409 `STALE_VERSION`. Retry permintaan terakhir dengan mutation ID/signature identik mengembalikan kondisi yang sama tanpa write. ID sama dengan signature berbeda ditolak `IDEMPOTENCY_CONFLICT`. Setelah Save lain berhasil, retry lama mendapat konflik. UUID versi dan mutation terakhir adalah guard teknis, bukan arsip.

## Transaksi dan akses

Runtime memakai postgres.js, `prepare:false`, koneksi maksimum lima, TLS `verify-full` pada remote, `statement_timeout=15s`, serta lock Project/Analysis. Semua perubahan metadata dan data workbook berada di transaksi yang sama. Kesalahan validasi, ownership, atau persistence membatalkan transaksi.

Save/ubah metadata menggunakan shared lock Project dan exclusive lock Analysis; penghapusan Project tetap exclusive. Analysis berbeda tidak saling menunggu lock Project selama tidak ada penghapusan. Save existing tidak lagi mencoba membuat/membaca ulang metadata induk yang sudah diverifikasi melalui current row. Pengaturan transaksi digabung dalam satu query, sedangkan pemeriksaan role, privilege, RLS dan klaim tetap berjalan setiap transaksi. Tes mencatat 11 perintah SQL untuk Save existing, termasuk BEGIN/COMMIT, dibanding 17 berdasarkan jalur kode sebelum optimasi. Ini pengurangan query, bukan pengukuran latensi browser.

Auth server memverifikasi sesi sebelum repository menerima actor ID. Tiap transaksi memverifikasi login NOINHERIT yang hanya mempunyai membership `procurement_runtime`, lalu `SET LOCAL ROLE`, RLS, dan claims terverifikasi. Tiga tabel memakai ENABLE/FORCE RLS dan policy owner untuk SELECT/INSERT/UPDATE dengan USING/WITH CHECK. Login runtime tidak memperoleh hak administrasi atau akses langsung tabel melalui anon/authenticated. Tidak ada RPC histori atau trigger bisnis.

Konfigurasi runtime tetap memakai `apps/web/.env`, `SUPABASE_URL`, public/publishable key dan database URL sesuai `server/runtime-configuration.ts`. Jangan menampilkan isi kredensial. `NODE_EXTRA_CA_CERTS=./certs/supabase-prod-ca-2021.crt` harus ditetapkan sebelum Node untuk TLS remote; script dev/start sudah mengaturnya.

## Migration dan verifikasi

`20261019071911_current_only_procurement.sql` mengonversi current payload lama, menjaga worksheet dan stable IDs, menghapus dua belas tabel lama beserta trigger/constraints/grant/policy terkait, lalu menyisakan tiga tabel aktif. Migration lama yang sudah diterapkan tetap utuh sebagai rantai SQL deployment; tidak dijalankan startup. Script backfill arsip lama telah dihapus.

Pemeriksaan cloud 2026-10-20 mengonfirmasi migration current-only sudah diterapkan. Ledger kemudian direkonsiliasi untuk `202610160001`, `202610200001`, `20261020042433`, dan `20261020050647`, tanpa menjalankan SQL migration lagi. Migration dynamic lama hanya mengubah tabel arsip yang telah dihapus; ledger mencatat bahwa efeknya telah digantikan oleh current-only. Policy/grant hapus, tipe/default/constraint status dan hak kolom diperiksa sebelum ledger ditulis. Fingerprint isi seluruh tiga tabel bisnis sebelum/sesudah identik: `2b01067b7d4154b36491fac14c2cdc55`.

Migration baru `20261020154514_workbook_list_metadata.sql` hanya dibuat dan diuji lokal. Cloud belum mempunyai `analysis_date`. Jangan deploy client/API pagination sebelum migration ini diterapkan melalui cutover yang diotorisasi. Runtime mengembalikan `STORAGE_UPGRADE_REQUIRED` bila proyeksi belum tersedia; tidak kembali membongkar JSON untuk daftar. Migration tidak menghapus tabel atau mengubah JSON, versi, waktu simpan, mutation ID dan signature. Namun penambahan generated STORED menghitung metadata seluruh row dan memerlukan lock tabel; batas tunggu 5 detik dan statement 120 detik menggagalkan transaksi bila tidak dapat selesai. Belum dilakukan perubahan tersebut pada produksi.

Tes lokal terisolasi:

```sh
node --experimental-transform-types --test tests/current-persistence.test.ts
```

Memerlukan PostgreSQL 17 lokal (`PG_BIN` dapat menunjuk direktori bin). Harness membuat cluster sementara dengan data sintetis dan login terbatas; tidak membaca `.env` atau memakai cloud. Laporan lengkap dan daftar file: `docs/agent-context/PERSISTENCE_CURRENT_ONLY_AUDIT.md`.

## Backup manual tanpa biaya tambahan

`scripts/procurement-backup.ts` membuat arsip gzip berisi seluruh kolom tiga tabel, metadata versi/retry, ledger versi/nama, serta sumber migration yang sesuai. SHA-256 memeriksa arsip, isi data dan sumber migration. File baru berizin 0600 dan tidak menimpa file lama; `.local-backups/` dikecualikan dari Git. Arsip tidak dienkripsi: simpan pada media eksternal yang terlindungi bersama file `.sha256`. Buat backup setiap selesai pekerjaan penting/sebelum cutover, salin kedua file ke penyimpanan eksternal, dan ulangi verifikasi setelah disalin. Tidak ada scheduler, layanan tambahan atau paket berbayar.

Ekspor berikutnya memakai koneksi operator terpisah dengan BYPASSRLS melalui `BACKUP_DATABASE_URL` di file `.env.backup` yang tidak masuk Git. Jangan mengganti `DATABASE_URL` aplikasi dengan kredensial operator. Ekspor memakai transaksi repeatable-read/read-only agar semua pemilik dan ketiga tabel konsisten; login aplikasi sengaja tidak dapat membuat backup global.

```sh
NODE_EXTRA_CA_CERTS=./certs/supabase-prod-ca-2021.crt node --env-file=.env.backup --experimental-transform-types scripts/procurement-backup.ts export .local-backups/backup-NAMA-UNIK.json.gz
node --experimental-transform-types scripts/procurement-backup.ts verify .local-backups/backup-NAMA-UNIK.json.gz
```

Perintah `verify` hanya menerima file, tidak menerima URL database tujuan. Ia membuat cluster PostgreSQL lokal sementara, membangun schema dari sumber migration dalam arsip, memulihkan data secara atomik, membandingkan semua kolom bertipe termasuk presisi timestamp, memvalidasi workbook dan memeriksa tiga tabel serta ENABLE/FORCE RLS/12 policy. Cluster sementara dihapus setelah pemeriksaan. Gunakan hanya arsip tepercaya karena sumber SQL migration akan dieksekusi dalam cluster lokal.

Backup cloud nyata 2026-10-20 berhasil diekspor melalui satu SELECT snapshot operator yang sudah tersedia, lalu dipaketkan dengan utility yang sama. Satu Project, satu Analysis dan satu workbook berhasil dipulihkan lokal; ukuran 76.304 byte, SHA-256 arsip `e1ee1e8ebc9dbb8c20039ff895f9515e2ef8301a56eeaf93f0aa788db1dace1a`. File ada di `.local-backups/procurement-lvogjvwrohdszgknlplg-20261020.json.gz`, dengan checksum berdampingan. Belum disalin ke media eksternal karena tujuan belum diberikan.

Ini backup data/schema procurement, bukan backup seluruh project Supabase: akun/sesi Auth, password role, secret, pengaturan platform dan berkas Storage tidak tercakup. Pemulihan ke produksi tetap memerlukan operator, penyediaan kembali role/login serta identitas Auth dengan UUID pemilik yang sesuai; utility ini sengaja tidak mempunyai perintah restore produksi.

Utility menggunakan memori dan membatasi arsip terurai 256 MiB. Gunakan `pg_dump` untuk dataset lebih besar; ukuran backup nyata saat pemeriksaan jauh di bawah batas tersebut. Backup di luar mesin belum diverifikasi sampai kedua file disalin dan perintah `verify` berhasil pada salinannya.
