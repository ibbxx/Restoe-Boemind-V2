# Verifikasi Fase 4 — 2026-10-15

Status: **COMPLETE**. Project: `lvogjvwrohdszgknlplg`. Tidak ada pekerjaan Fase 5.

## Perubahan aktual

- Migration `20261015023734_procurement_actor_claims.sql` diterapkan melalui
  Supabase CLI 2.109.1 setelah tes wajib, `migration list`, backup privat, dan
  dry-run memastikan hanya migration tersebut tertunda. Migration awal tetap.
- Harness PostgreSQL menggunakan major 17, socket privat untuk repository, dan
  loopback dengan password acak serta TLS untuk CLI. Bug rekonstruksi URL Unix
  socket tidak lagi menyebabkan SKIP dry-run. PG17 diuji: 17.11 (Homebrew).
- Tes upgrade membandingkan OID/definisi tabel, constraints, indexes, privileges,
  RLS dan delapan trigger sebelum/sesudah upgrade, rollback serta retry.
- Verifier cloud dapat membaca ledger dengan `SUPABASE_MIGRATION_AUDIT_URL`
  melalui koneksi operator terpisah, read-only, dengan target database/TLS yang
  sama. Kredensial ini tidak menjadi login repository dan tidak menambah grants
  runtime. Regression test memeriksa pemisahan dan penolakan target berbeda.
- Runtime tetap memakai `procurement_app_login` dari `apps/web/.env` (0600,
  diabaikan Git, tidak terlacak), dengan membership runtime INHERIT FALSE,
  SET TRUE, ADMIN FALSE. Tidak ada perubahan privilege administratif atau guard.

## Hasil aktual

| Pemeriksaan | Hasil |
|---|---|
| `npm run test:postgres`, PATH PostgreSQL 17 | 38 PASS, 0 FAIL, 0 SKIP |
| `RUN_POSTGRES_TESTS=1 npm run check`, PATH PostgreSQL 17 | 235 PASS, 0 FAIL, 0 SKIP, 1 TODO EV-005 lama |
| `npm run build` setelah perubahan terakhir | PASS |
| Cloud guard unit tests | 14 PASS |
| `npm run test:supabase -- --write`, database fixture terisolasi | 9 PASS, 0 FAIL, 0 GAP; exit 0 |
| HTTP aplikasi sebenarnya, production build | 8 kelompok pemeriksaan PASS, termasuk restart proses |
| Runtime guard database production setelah cleanup | PASS |
| Cloud catalog setelah migration | PASS: dua ledger records, helper invoker, 34 policy, 14 ENABLE/FORCE RLS tables |
| Integritas cloud | Tabel/grants, constraints, indexes dan 8 trigger sama dengan snapshot sebelum migration |
| Cleanup cloud | 0 database fixture, 0 akun Auth fixture, 0 sesi fixture, 0 project fixture di procurement production |

Tes wajib dijalankan dengan `/opt/homebrew/opt/postgresql@17/bin` di awal PATH;
PostgreSQL 14 yang sudah ada tidak diubah atau dipakai sebagai bukti PG17.
`git diff --check` dan pemeriksaan whitespace file yang belum terlacak dijalankan.

## Cakupan end-to-end dan cleanup

Dua akun fixture dibuat melalui Auth admin API resmi dengan email terkonfirmasi,
lalu login password dan `/auth/v1/user` benar-benar menghasilkan/menvalidasi dua
sesi berbeda. Token/password disimpan privat dan tidak dicetak atau dikomit.

Pengujian HTTP memakai Next.js production server pada loopback, Supabase Auth
project asli, login SQL aplikasi asli, dan database cloud sementara terpisah dalam
project yang sama. Database sementara mendapat kedua migration melalui CLI,
termasuk ledger; seluruh Save/Restore benar-benar commit, bukan transaksi mock.
Database `postgres` production tidak menerima baris fixture procurement.

PASS mencakup Save, Reload, retry idempotent, penolakan stale revision, Restore
sebagai revisi baru, Replay/history immutable, penolakan baca/tulis/restore silang,
token hilang/invalid/tampered, dan pengabaian header identitas palsu. Koneksi SQL
baru membaca commit HTTP yang sama. Restart proses Next.js mempertahankan head
dan tiga revisi serta isolasi pengguna.

Claim kosong, malformed dan tidak konsisten ditolak oleh helper/RLS. Pada satu
backend SQL yang dipakai ulang, role dan kedua claim dibersihkan setelah commit
maupun rollback. Repository memasang role, claim dan query bisnis dalam transaksi
yang sama; identitas berasal dari validasi token backend.

Setelah tes, server uji dihentikan, database fixture dihapus secara keseluruhan,
sesi Auth dicabut dan dua akun fixture dihapus melalui API resmi. Tidak ada
penonaktifan RLS/trigger, penghapusan baris histori production, reset database
production, atau perubahan ledger manual. Query katalog memastikan cleanup.

## Batas bukti

TLS client-ke-pooler diverifikasi dengan CA resmi dan hostname verification.
`pg_stat_ssl` melaporkan `ssl=false` untuk hop pooler-ke-backend; ini observasi
hop berbeda, bukan bukti enkripsi hop internal tersebut.

Verifier production mode read-only memang menandai operasi tulis sebagai GAP;
operasi tersebut dibuktikan terpisah melalui mode write dan HTTP pada database
fixture terisolasi. Ledger production juga diperiksa langsung dengan operator.
EV-005 tetap TODO sesuai invariant; tidak diubah menjadi oracle penerimaan.
Build/tes ini tidak menyatakan deployment hosting aplikasi telah dilakukan.
