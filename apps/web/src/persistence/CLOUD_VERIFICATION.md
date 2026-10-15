# Verifikasi Supabase Cloud Fase 4

Panduan ini melanjutkan [implementasi persistence](./README.md). Skrip memakai
SupabaseAuthenticator, PostgresRevisionRepository, handler aplikasi dan fixture
struktural yang sudah ada. Tidak ada perubahan engine, formula atau expected value.

## Status yang telah diperiksa

Audit 14 Oktober 2026 menemukan URL/key di root `.env` dengan nama NEXT_PUBLIC yang
tidak dibaca runtime. Konfigurasi itu dipindahkan ke `apps/web/.env.local`, nama
diubah menjadi SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY tanpa mengubah nilainya, dan
file dilindungi gitignore serta izin 0600. DATABASE_URL dan sesi uji A/B belum tersedia.

Key lokal bertipe legacy anon, cocok dengan key aktif project berdasarkan perbandingan
privat, dan bukan service-role key. GET Auth settings berhasil, tetapi REST metadata
mengembalikan 401 Invalid API key. Penyebab penolakan antar-layanan belum terverifikasi;
metadata key aktif dan respons settings bukan bukti Auth pengguna atau akses REST valid.
Jangan mengganti key, mengaktifkan API atau memberi grant cloud untuk menutupi gejala.

Query katalog MCP berhasil ke PostgreSQL 17.11; schema procurement dan migration ledger
belum ditemukan. MCP memakai role postgres, bukan role aplikasi read-only; audit hanya
menjalankan SELECT. Koneksi ini tidak membuktikan DATABASE_URL/pooler/TLS aplikasi.
Auth sesi pengguna, RLS data dan alur persistence cloud belum diuji. PostgreSQL lokal
tidak dianggap bukti integrasi Supabase cloud. Kondisi cloud dapat berubah; verifikasi ulang.

## 1. Konfigurasi lokal privat

Gunakan secret manager atau `apps/web/.env.local` yang diabaikan git. Isi nilai asli
di mesin lokal, jangan kirim melalui chat atau commit. Jangan gunakan `set -x`,
`env`, `printenv`, token dalam argument CLI, atau menyalin raw connection error.

Variabel wajib:

- `DATABASE_URL`: connection string resmi dari project yang sama. Untuk membuktikan
  jalur pooler, gunakan endpoint pooler dengan username `connection_role.PROJECT_REF`.
- `SUPABASE_URL`: `https://PROJECT_REF.supabase.co` dari project uji/staging.
- `SUPABASE_PUBLISHABLE_KEY`: publishable key atau legacy anon key, bukan service-role key.
- `SUPABASE_TEST_ACCESS_TOKEN_A` dan `SUPABASE_TEST_ACCESS_TOKEN_B`: access token sesi
  aktif dua akun uji berbeda dari project itu. Publishable key saja tidak mengautentikasi pengguna.

Opsional: `SUPABASE_CLOUD_ANALYSIS_ID_A`, Analysis yang sudah dimiliki akun A, untuk
menguji pembacaan terisolasi tanpa menambah data. Tidak perlu memberi password akun
kepada skrip; pembuatan akun/login dan token refresh dilakukan lewat Auth yang dipilih.

Connection role server harus dapat `SET ROLE procurement_runtime` dan bukan role
browser. Login harus NOINHERIT/non-admin, hanya memiliki membership runtime tanpa
ADMIN OPTION; role runtime harus NOLOGIN/NOINHERIT/non-admin dan tidak memiliki
membership lain. Runtime dan preflight memeriksa identitas login, ownership, grant
dan RLS efektif pada setiap transaksi melalui guard yang sama. Kredensial migrator
ditolak untuk jalur ini; migration tidak memberi membership runtime otomatis ke
pelaksananya. Provisioning login/membership tetap tindakan operator terpisah.
Pada PG16+ membership perlu INHERIT FALSE dan SET TRUE; jangan hanya memeriksa
atribut NOINHERIT pada login. Jangan menggunakan
`NEXT_PUBLIC_` untuk database password. Jika CA khusus diperlukan, konfigurasi CA
tepercaya (misalnya NODE_EXTRA_CA_CERTS) sebelum Node dimulai; jangan mematikan TLS.

## 2. Preflight read-only

### Diagnostik koneksi sebelum migration

Gunakan `npm run test:supabase -- --connectivity-only` untuk memeriksa Session Pooler
tanpa membutuhkan schema procurement, role runtime, token pengguna, atau repository.
Mode ini hanya membaca metadata database/versi/identitas role dalam `BEGIN READ ONLY`;
hasil mencantumkan `scope: CONNECTIVITY_ONLY`. Exit 0 hanya membuktikan koneksi
diagnostik, bukan runtime atau persistence. Kombinasi dengan `--write` ditolak.

Kredensial harus diberikan melalui `PREFLIGHT_DATABASE_URL` di environment proses
sementara, bukan disimpan di `.env.local` atau disalin ke `DATABASE_URL` aplikasi.
Tidak ada fallback antara keduanya. URL/key API yang sudah tersedia tetap dibaca
untuk validasi project/TLS bersama, tanpa memanggil Auth pengguna pada mode ini.
Login administratif yang sudah tersedia boleh digunakan hanya untuk diagnostik ini;
guard runtime dan persyaratan login aplikasi non-admin tidak berubah.

Langkah Dashboard untuk project yang dimaksud:

1. Buka project, klik **Connect**, pilih **Session pooler**, format URI. Cocokkan
   host/port dengan detail Dashboard; mode ini hanya menerima Shared Pooler port 5432.
2. Gunakan password database yang sudah ada untuk login yang tercantum pada URI,
   bukan publishable/API key. Untuk diagnostik `postgres`, username pooler adalah
   `postgres.PROJECT_REF`. Isi placeholder password secara privat dan percent-encode
   karakter khusus. Jika password tidak diketahui, ambil dari penyimpanan privat
   operator; jangan reset password atau membuat role hanya untuk tes ini.
3. Buka **Database → Settings → SSL Configuration → Download certificate**.
   Simpan CA publik di lokasi lokal pilihan operator, di luar aplikasi. Jangan
   mengubah toggle SSL enforcement. `NODE_EXTRA_CA_CERTS` harus diberikan sebelum
   Node dimulai; mengisinya setelah startup tidak memperbarui trust store Node.

Probe 14 Oktober 2026 pada kandidat Dashboard
`aws-0-ap-southeast-1.pooler.supabase.com:5432` mengamati rantai
`*.pooler.supabase.com → Supabase Intermediate 2021 CA → Supabase Root 2021 CA`.
Trust store default gagal dengan `SELF_SIGNED_CERT_IN_CHAIN`. CA yang diambil dari
[URL unduhan resmi Studio](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)
melalui HTTPS cocok dengan root yang diamati; handshake Node kemudian berhasil
dengan TLS 1.3, verifikasi chain/hostname aktif, dan hostname lain ditolak.
Ini probe transport tanpa login/SQL, bukan bukti koneksi PostgreSQL authenticated.
Tidak ada CA/kredensial yang dipasang otomatis ke konfigurasi aplikasi.

Jalankan dari `apps/web` dengan zsh; input URI disembunyikan dan tidak menjadi
argumen CLI atau baris history. Subshell membatasi masa hidup variabel diagnostik:

```sh
(
  set +x
  read -r 'PROCUREMENT_CA_FILE?Path absolut CA yang diunduh: '
  read -rs 'PREFLIGHT_DATABASE_URL?Tempel URI Session Pooler lengkap (tersembunyi): '
  print
  export PREFLIGHT_DATABASE_URL
  NODE_EXTRA_CA_CERTS="$PROCUREMENT_CA_FILE" npm run test:supabase -- --connectivity-only
)
```

Jangan gunakan `rejectUnauthorized:false`, TLS `require`, atau
`NODE_TLS_REJECT_UNAUTHORIZED=0`. Jangan mempercayai sertifikat dari koneksi yang
gagal tanpa memperoleh CA secara independen dari Dashboard/sumber resmi.

Urutan berikutnya: review migration; setelah otorisasi penerapan, buat schema/role
NOLOGIN/tabel/RLS melalui migration; provisioning login aplikasi non-admin serta
membership terpisah (PG16+: INHERIT FALSE, SET TRUE, tanpa ADMIN OPTION); kemudian
jalankan verifikasi runtime di bawah. Guard penuh baru relevan setelah seluruh
objek/privilege tersebut tersedia. Tidak satu pun langkah provisioning/migration
dijalankan oleh mode diagnostik.

### Verifikasi runtime setelah migration dan provisioning

Forward migration yang perlu review: `20261015023734_procurement_actor_claims.sql`.
Migration awal tidak diubah. Forward migration menambah helper invoker tanpa argumen
`procurement.current_actor_id()` dan mengganti ekspresi owner pada 34 policy; tetap
14 tabel ENABLE/FORCE RLS dan grant tabel/kolom yang sama. Tidak ada grant schema auth,
provisioning login, perubahan membership, atau penulisan ulang histori.

Helper memerlukan dua claim transaction-local yang konsisten dari repository:
`request.jwt.claim.sub` dan JSON `request.jwt.claims` dengan sub sama dan role
`authenticated`. Klaim kosong/malformed/tidak cocok menghasilkan NULL (deny).
Ini tidak memverifikasi JWT di SQL: verifikasi tetap melalui `/auth/v1/user` pada server.
Kredensial SQL tidak boleh diberikan ke end user karena pemegang koneksi SQL dapat
menetapkan GUC sendiri, sama seperti batas kepercayaan implementasi sebelumnya.

Urutan deployment: review forward migration dan backup; jalankan
`supabase db push --dry-run --linked` dan pastikan hanya forward migration tersebut
tertunda; setelah persetujuan terpisah terapkan migration, baru deploy guard baru.
Jangan mengubah ledger lama atau mengembalikan policy ke auth.uid() untuk rollback
pada cloud yang tidak mempunyai USAGE auth. Kegagalan sebelum commit harus rollback
helper, ALTER POLICY, dan ledger sekaligus; setelah commit gunakan forward fix yang direview.
Local CLI migration tests memakai cluster Unix socket privat, bukan kredensial cloud.
Pada CLI 2.109.1, `db push --dry-run` dapat salah membentuk ulang URL socket tersebut;
tes menandai batas ini SKIP/GAP, bukan bukti dry-run cloud berhasil. Runner
`migration up` tetap diuji dengan kegagalan DDL/ledger serta retry secara lokal.

Login aplikasi harus non-admin/NOINHERIT, tanpa ownership/direct grants atau role lain.
PG16+ membership procurement_runtime harus ADMIN FALSE, INHERIT FALSE, SET TRUE.
Provisioning dan pengisian DATABASE_URL secara privat tetap tindakan operator;
CLI/MCP/postgres administratif bukan kredensial runtime. Supabase Auth dua sesi
pengguna berbeda diperlukan untuk pengujian isolasi nyata setelah preflight lulus.

```sh
cd apps/web
npm run test:supabase
```

Perintah membaca `.env.local` jika ada; environment proses lebih diprioritaskan.
Mode default tetap read-only meski flag izin tulis tertinggal di environment.
Koneksi SQL memiliki default_transaction_read_only=on, `prepare:false` dan
`ssl:verify-full`. URL parameter yang dapat mengubah koneksi/TLS ditolak.
Skrip menolak target database yang tidak cocok dengan Auth project. Custom domain
atau proxy lain tidak diterka: gunakan URL project resmi untuk verifikasi ini.
Validasi target dan TLS ini kini juga digunakan runtime, bukan hanya skrip pengujian.

Yang diperiksa: Auth live A/B, koneksi dengan sertifikat diverifikasi, schema/RLS
14 tabel, atribut role, larangan akses schema bagi anon/authenticated, migration
ledger bila dapat dibaca, dan RLS data bila Analysis A diberikan. Hasil berupa
PASS/FAIL/GAP tanpa token, key, password, connection string atau raw driver error.

Exit 0 berarti seluruh pemeriksaan dalam scope yang diminta lulus; 1 berarti pemeriksaan gagal;
2 berarti GAP seperti environment/token/migration ledger atau izin tulis belum tersedia.
Mode read-only selalu mencatat Save/restore sebagai GAP, bukan mengklaim alur itu lulus.
Jika jalur direct dipakai, pemeriksaan pooler tetap GAP. `pg_stat_ssl` melalui pooler
menggambarkan hop pooler→PostgreSQL, bukan handshake Node→pooler; observasinya dicatat
terpisah dari koneksi client yang diwajibkan verify-full.

## 3. Migration: inspeksi dahulu, perubahan harus diizinkan

Migration aktual adalah
[`202610140001_procurement_storage.sql`](../../supabase/migrations/202610140001_procurement_storage.sql).
Skrip tidak menerapkan migration, membuat role, melakukan repair/reset, ataupun
memodifikasi migration history. Adanya schema bukan bukti ledger sudah sinkron.

Operator berizin dapat memeriksa ledger dari SQL Editor dengan query SELECT berikut
(hanya setelah memastikan project yang benar):

```sql
begin read only;
select version from supabase_migrations.schema_migrations
where version = '202610140001';
commit;
```

Jika CLI memang sudah dikonfigurasi dan ditautkan ke project yang benar, operator
dapat menggunakan `supabase migration list` dan `supabase db push --dry-run` untuk
inspeksi/preview. Workspace saat ini belum memiliki `supabase/config.toml`; jangan
menjalankan perintah linked-project dengan menebak target atau menganggap setup CLI tersedia.

Jika migration belum diterapkan, berhenti dan minta persetujuan untuk file/target
spesifik. `db push` tanpa dry-run, role provisioning, migration repair, dan cleanup
memerlukan otorisasi tersendiri. Jangan menerapkan ulang SQL ketika schema sudah ada.

### Atomicity migration dan ledger

Runner yang diverifikasi adalah **Supabase CLI 2.109.1**. Port TypeScript yang
terpasang menjalankan `legacyApplyMigrationFile`: transaksi runner membungkus
statement SQL dan INSERT `supabase_migrations.schema_migrations`, kemudian COMMIT.
Implementasi Go `MigrationFile.ExecBatch` memakai batch transaksional implisit
untuk pasangan yang sama. File ini tidak memiliki BEGIN/COMMIT top-level agar
tidak memutus transaksi runner sebelum ledger. Blok PL/pgSQL tetap dipertahankan.
Tidak ada statement non-transaksional seperti CREATE INDEX CONCURRENTLY/VACUUM;
menambah statement demikian memerlukan review baru karena runner memecah batch.

Bootstrap tabel ledger adalah transaksi terpisah: kegagalan boleh meninggalkan
tabel ledger kosong, tetapi tidak schema/role/tabel procurement atau version yang
seolah-olah sudah diterapkan. Jangan menjalankan file per statement melalui SQL
Editor/autocommit atau psql biasa. Caller tes lokal yang tidak memakai CLI memiliki
transaksi eksplisit sendiri; itu bukan bukti pencatatan ledger oleh CLI.

`npm run test:postgres` juga memerlukan CLI 2.109.1 dan menguji binary tersebut
terhadap socket privat cluster sementara: error sebelum INSERT ledger, penolakan
BEFORE INSERT, error deferred AFTER INSERT saat COMMIT, sukses atomik dan retry.
Versi server adalah versi `postgres`/`initdb` di PATH; tes PG14 tidak membuktikan PG17.

### Recovery: schema ada, ledger version tidak ada

Berhenti; jangan DROP schema, rerun migration awal, atau repair otomatis. Simpan
backup dan artefak SQL asli beserta hash/provenance. Operator harus membandingkan
seluruh tabel, kolom, constraint/FK/index, function/trigger, ownership, role/grant,
RLS/policy dan inventaris data dengan artefak yang benar-benar sudah diterapkan,
serta memastikan prosedur restore backup dapat dijalankan.

Hanya bila penerapan lengkap dan identik terbukti, ledger-only reconciliation untuk
version **202610140001** dapat direview dan diizinkan secara terpisah menggunakan
`supabase migration repair --status applied` dengan version/target eksplisit dan
artefak yang sudah diverifikasi (CLI merekam statement file tersebut tanpa rerun).
Ini bukan perbaikan schema atau persetujuan menandai objek parsial sebagai lengkap.
Jika objek parsial/berbeda, perlu forward migration atau recovery yang direview,
bukan repair ledger saja. Jangan menandai `reverted` untuk memaksa rerun.

Regression test mereproduksi orphan dari COMMIT lama di cluster disposable dan
menguji repair eksplisit yang mempertahankan OID, snapshot, event, history dan
replay. Tes tidak melakukan recovery, cleanup, atau write ke project cloud.

## 4. Alur tulis cloud — hanya setelah persetujuan eksplisit

Gunakan staging/project uji. Setelah izin remote-write diberikan, atur dua flag
berikut secara lokal (PROJECT_REF adalah identifier publik, bukan secret):

```sh
export SUPABASE_CLOUD_ALLOW_WRITES=1
export SUPABASE_CLOUD_CONFIRM_PROJECT=PROJECT_REF_YANG_DISETUJUI
npm run test:supabase -- --write
```

Ketiga syarat harus terpenuhi: argumen `--write`, ALLOW_WRITES=1, dan confirmation
project yang cocok. Auth dua pengguna, TLS dan schema/RLS harus lulus dahulu.
Ini merupakan aksi tulis tersendiri; tersedianya kredensial bukan persetujuan.

Skrip membuat Project/Analysis sintetis dengan UUID acak menggunakan fixture yang
sudah ada, lalu menguji Save Draft, reload, perubahan HPP manual, retry idempoten,
stale revision 409, penolakan akses/tulis pengguna B, restore sebagai revisi baru,
replay snapshot lama dan jumlah history. Ia tidak menghitung atau mengonfirmasi hasil.

Data uji sengaja dipertahankan: tiga revisi draft immutable beserta snapshot/event
dan identitas terkait. ID fixture dilaporkan tanpa secret, termasuk bila langkah
berikutnya gagal. Tidak ada DELETE/cleanup otomatis; penghapusan data uji memerlukan
izin lain. Jangan jalankan tes lokal PostgreSQL terhadap DATABASE_URL remote.

## Acuan teknis

- [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Postgres.js dengan Supabase](https://supabase.com/docs/guides/database/postgres-js)
- [Migration workflow](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Runner CLI 2.109.1 (TypeScript)](https://github.com/supabase/cli/blob/v2.109.1/apps/cli/src/legacy/shared/legacy-migration-apply.ts)
- [Runner CLI 2.109.1 (Go)](https://github.com/supabase/cli/blob/v2.109.1/apps/cli-go/pkg/migration/file.go)
- [Ledger-only repair CLI 2.109.1](https://github.com/supabase/cli/blob/v2.109.1/apps/cli/src/legacy/commands/migration/repair/repair.handler.ts)
- [Node.js NODE_EXTRA_CA_CERTS](https://nodejs.org/docs/latest-v22.x/api/cli.html#node_extra_ca_certsfile)

Fase 5, solver, tarif/pajak, mapping bisnis dan penyelesaian EV-005 tetap di luar tugas ini.
