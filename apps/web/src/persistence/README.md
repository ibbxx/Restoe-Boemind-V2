# Persistence: kondisi aktif Analysis

Satu Project mempunyai banyak Analysis. `PostgresWorkbookRepository` menyimpan tepat satu row `current_workbooks` per Analysis dengan primary key `analysis_id`. Semua Save baru menggunakan UPSERT; tidak membuat arsip.

Tabel aktif hanya `projects`, `analyses`, dan `current_workbooks`. Metadata nama Project/Analysis berada pada dua tabel pertama; `current_workbooks.data` menyimpan satu payload normalized dengan worksheet, input, formula aktif, mapping aktif, pilihan offer per profil, dan satu konfigurasi engine. Nilai vendor manual berada pada `offers[].values`; cell storage memakai `OFFER_VALUE { offerId, valueId }`. Adapter mematerialisasi INPUT untuk editor dan engine tanpa menyimpan salinan kedua. Formula vendor tetap definisi formula aktif, tanpa menyimpan hasil evaluasi atau salinan ekspresi sebagai nilai offer.

Tidak ada revisions, events, offer revisions, run history, head pointer, arsip workbook, tabel formula/mapping tambahan, atau ledger retry. `WorkbookSnapshot` adalah nama tipe immutable untuk kondisi di memori, bukan arsip database. Preview engine termasuk input/configuration untuk incremental recalculation hanya hidup di memori, tidak dipersistensikan.

## API

- GET `/api/workbook?view=projects`
- GET `/api/workbook?view=analyses&projectId=<UUID>`
- GET `/api/workbook?analysisId=<UUID>` atau `view=current`
- POST `/api/workbook`: `{ operation: "SAVE", request: { snapshot, configuration, expectedVersion, mutationId } }`

GET current mengembalikan `{ snapshot, configuration, version, savedAt, savedBy }` atau null. Wire format adalah tampilan workbook yang dimaterialisasi; penyimpanan `data` dinormalisasi oleh `workbook-data.ts`. Field domain `selectedOfferId` dan `workbook.selections` merujuk offer aktif. Tidak menerima payload offer-revision lama atau RESTORE/CALCULATE/history/replay/runs.

Sukses Save: `{ status: "SAVED", workbook }`. Versi tertinggal: HTTP 409 `STALE_VERSION`. Retry permintaan terakhir dengan mutation ID/signature identik mengembalikan kondisi yang sama tanpa write. ID sama dengan signature berbeda ditolak `IDEMPOTENCY_CONFLICT`. Setelah Save lain berhasil, retry lama mendapat konflik. UUID versi dan mutation terakhir adalah guard teknis, bukan arsip.

## Transaksi dan akses

Runtime memakai postgres.js, `prepare:false`, koneksi maksimum lima, TLS `verify-full` pada remote, `statement_timeout=15s`, serta lock Project/Analysis. Semua perubahan metadata dan data workbook berada di transaksi yang sama. Kesalahan validasi, ownership, atau persistence membatalkan transaksi.

Auth server memverifikasi sesi sebelum repository menerima actor ID. Tiap transaksi memverifikasi login NOINHERIT yang hanya mempunyai membership `procurement_runtime`, lalu `SET LOCAL ROLE`, RLS, dan claims terverifikasi. Tiga tabel memakai ENABLE/FORCE RLS dan policy owner untuk SELECT/INSERT/UPDATE dengan USING/WITH CHECK. Login runtime tidak memperoleh hak administrasi atau akses langsung tabel melalui anon/authenticated. Tidak ada RPC histori atau trigger bisnis.

Konfigurasi runtime tetap memakai `apps/web/.env`, `SUPABASE_URL`, public/publishable key dan database URL sesuai `server/runtime-configuration.ts`. Jangan menampilkan isi kredensial. `NODE_EXTRA_CA_CERTS=./certs/supabase-prod-ca-2021.crt` harus ditetapkan sebelum Node untuk TLS remote; script dev/start sudah mengaturnya.

## Migration dan verifikasi

`20261019071911_current_only_procurement.sql` mengonversi current payload lama, menjaga worksheet dan stable IDs, menghapus dua belas tabel lama beserta trigger/constraints/grant/policy terkait, lalu menyisakan tiga tabel aktif. Migration lama yang sudah diterapkan tetap utuh sebagai rantai SQL deployment; tidak dijalankan startup. Script backfill arsip lama telah dihapus.

Cloud belum menerima migration ini. Hentikan writer lama, jalankan migration melalui operator dalam transaksi, lalu buka aplikasi baru. Runtime baru mengembalikan `STORAGE_UPGRADE_REQUIRED` jika kolom `data` belum tersedia. Penghapusan histori destruktif dan tidak mempunyai down-migration.

Tes lokal terisolasi:

```sh
node --experimental-transform-types --test tests/current-persistence.test.ts
```

Memerlukan PostgreSQL 17 lokal (`PG_BIN` dapat menunjuk direktori bin). Harness membuat cluster sementara dengan data sintetis dan login terbatas; tidak membaca `.env` atau memakai cloud. Laporan lengkap dan daftar file: `docs/agent-context/PERSISTENCE_CURRENT_ONLY_AUDIT.md`.
