# PostgreSQL / Supabase — Fase 4

Prosedur dan perintah uji cloud: [CLOUD_VERIFICATION.md](./CLOUD_VERIFICATION.md).
`npm run test:supabase` menjalankan preflight read-only; remote writes memerlukan
persetujuan dan aktivasi terpisah sebagaimana dijelaskan pada panduan tersebut.

Schema: [`../../supabase/migrations/202610140001_procurement_storage.sql`](../../supabase/migrations/202610140001_procurement_storage.sql).
Forward policy contract: [`../../supabase/migrations/20261015023734_procurement_actor_claims.sql`](../../supabase/migrations/20261015023734_procurement_actor_claims.sql).
Adapter: `PostgresRevisionRepository`. API: `GET/POST /api/workbook` (Node server runtime).
Scope fase mengikuti instruksi pengguna terbaru; Auth/per-user storage kini diminta
eksplisit walaupun PRD v1.7 menyebut multi-user/Auth di luar scope MVP awal.

## Data dan transaksi

Project dimiliki satu Supabase user; Analysis adalah workspace di bawah Project.
Vendor/offer serta head/history selalu berada dalam Analysis. Sharing/invitation,
role bisnis, master vendor global dan compliance gate tidak diimplementasikan.

Schema privat `procurement` menyimpan Project, Analysis, vendor/offer/revisions,
snapshot JSONB schema v2, revision envelope, event, mutation/idempotency record,
mapping/formula versions, calculation run/manifests dan latest preview pointer.
Snapshot adalah state historis otoritatif; tabel vendor/offer adalah indeks identitas
dan metadata terakhir. Menghapus identitas dari draft tidak menghapus histori fisik.

Save/Restore Analysis hanya membuat Project bila belum ada; keduanya tidak mengubah
metadata Project yang sudah tersimpan. Nama Project di snapshot tetap merupakan
metadata historis, bukan perintah rename. API perubahan Project tersendiri belum
tersedia; tidak ada rename implisit melalui payload Save.

Nomor revisi offer memakai integer positif sampai `9007199254740991`, sesuai
`Number.MAX_SAFE_INTEGER`; SQL memakai `bigint` dengan batas yang sama. Pasangan
offer ID/nomor revisi tetap terikat pada ID revisi aslinya sepanjang histori, termasuk
setelah revisi tidak ada di state terbaru. Retry/restore boleh merujuk ID asli.

CHECK JSONB menjaga key envelope wajib dan identitas kolom/payload; validasi detail
domain tetap melalui parser server. FK komposit Calculation Run memastikan revision
dan snapshot berasal dari pasangan tersimpan yang sama dalam Analysis.

Setiap Save/Restore memakai satu transaksi PostgreSQL: lock per Analysis (termasuk
first save), pemeriksaan retry, optimistic revision guard, domain transition yang
sama dengan repository in-memory, insert versi/snapshot/revision/event, kemudian
head dan mutation record. Kegagalan apa pun rollback seluruh transaksi. Retry
mutation/payload/actor identik mengembalikan revision/event asli meski head berubah.
Revisi stale ditolak; tidak ada overwrite atau merge. Restore selalu revisi draft baru.
Tidak ada autosave atau database migration saat aplikasi startup/build.

Input bisnis yang belum valid boleh disimpan sebagai draft. Domain schema, ID,
scope, HPP manual dan immutable versions tetap divalidasi. Confirm selalu ditolak
sebagai CONFIRMATION_UNAVAILABLE sampai policy finalisasi bisnis disahkan.

`calculate` memuat revisi persisten lalu memanggil FormulaEngine yang sama. Hanya
run yang diterbitkan engine dengan snapshot/revision/configuration tepat dapat
disimpan. Lock/head diperiksa lagi saat publikasi; run stale tidak mengganti latest.
Run/manifests lama tetap tersimpan dan dapat direproduksi dengan konfigurasi aslinya.
Retry run yang sudah tersimpan tidak memundurkan pointer latest ke preview lama pada
revision yang sama. FK pointer juga mengikat profil, bukan hanya Analysis dan run ID.
Policy/aggregate version compatibility diperiksa terhadap manifest persisten agar
restart/server lain tidak bisa menulis payload baru dengan version ID yang sama.
Referensi run pada Save harus cocok dengan manifest persisten, bukan metadata client.

## Auth dan RLS

API menerima `Authorization: Bearer <Supabase access_token>`. Server memverifikasi
token melalui `GET /auth/v1/user`; actor tidak diambil dari body atau decode JWT.
Gunakan sesi dari Supabase Auth; UI login, OAuth provider pilihan dan refresh UI
belum menjadi scope ini. Token/password tidak disimpan oleh workbook server.

Semua query memakai transaksi dengan `SET LOCAL ROLE procurement_runtime`
(NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS), lalu claim user yang telah diverifikasi.
Sebelum perubahan role, `runtime-role.ts` memeriksa identitas session/current user,
atribut login non-admin (termasuk NOINHERIT, NOCREATEROLE, NOCREATEDB, NOREPLICATION),
membership transitive serta ADMIN OPTION. Login hanya
boleh menjadi member runtime tanpa mewarisi haknya secara langsung; runtime tidak
boleh menjadi member role lain. Nama username bukan bukti keamanan.

Sesudah SET ROLE, guard memeriksa ownership/DDL, role efektif, RLS aktif/forced pada 14 tabel,
SELECT/INSERT dan UPDATE kolom yang dibutuhkan, serta menolak hak rewrite history,
grant option dan SECURITY DEFINER yang dapat dipanggil pada schema procurement.
Pemeriksaan dilakukan pada setiap transaksi/koneksi, bukan cache otorisasi startup.
Search path transaksi dibatasi ke pg_catalog, pg_temp; penolakan tidak mengekspos
identitas/kredensial database. Role login/runtime tidak boleh memiliki objek atau
CREATE pada schema permanen; guard tidak mengubah grant global untuk meloloskannya.
Setelah forward migration, semua tabel tetap memakai ENABLE/FORCE RLS dengan
pemeriksaan owner melalui `procurement.current_actor_id()`, bukan `auth.uid()`.
Helper STABLE/SECURITY INVOKER tanpa argumen membaca `request.jwt.claim.sub` dan
`request.jwt.claims`; keduanya ditetapkan dengan `set_config(..., true)` sesudah
verifikasi Auth dan SET LOCAL ROLE. Sub harus UUID v4 yang cocok pada kedua claim,
dengan role `authenticated`. Claim kosong, malformed atau tidak konsisten menghasilkan
NULL sehingga policy menolak akses. EXECUTE hanya untuk runtime dan pemilik fungsi;
PUBLIC/anon/authenticated tidak mendapat EXECUTE. Tidak diperlukan USAGE schema auth.
Claim lokal adalah konteks query, bukan mekanisme verifikasi token. Kredensial SQL
hanya dimiliki server tepercaya. Tidak ada grant schema/tabel ke anon/authenticated,
tidak ada SECURITY DEFINER RPC, dan schema tidak perlu diekspos lewat PostgREST.

Runtime tidak mendapat UPDATE/DELETE pada histori. Trigger juga menolak rewrite
snapshot/event/versi/run. Hak UPDATE indeks metadata/head dibatasi kolom. Respons
API tidak mengungkap SQL, connection string atau driver errors dan memakai no-store.
Tidak ada service-role key yang diperlukan/dibaca. Driver PostgreSQL memiliki akses
jaringan server dan tidak diimpor dari UI/domain/engine.
Migration mencabut grant schema/tabel bawaan untuk PUBLIC/anon/authenticated sebelum
memberi hak runtime terbatas. Notice mentah driver tidak dicetak oleh koneksi runtime.

## Konfigurasi (belum diterapkan ke remote)

Environment server di `apps/web/.env.local` atau secret store:

- `DATABASE_URL`: koneksi PostgreSQL/Supabase direct/session atau transaction pooler.
- `SUPABASE_URL`: URL project Supabase (HTTPS, atau HTTP localhost untuk pengembangan).
- `SUPABASE_PUBLISHABLE_KEY`: publishable key atau legacy anon JWT; privileged key ditolak.

Jangan memakai prefix NEXT_PUBLIC untuk DATABASE_URL atau menyimpan kredensial di git.
Runtime memakai `prepare: false` untuk transaction pooler dan TLS verify-full untuk
host remote; jangan menonaktifkan verifikasi sertifikat. Gunakan connection role
server khusus dengan NOINHERIT, NOSUPERUSER, NOBYPASSRLS dan membership
`procurement_runtime`; jangan membagikan database password ke browser.

Runtime dan preflight memakai `src/server/runtime-configuration.ts` yang sama untuk
memvalidasi target Auth/database, username pooler, jenis public key dan parameter TLS.
Remote harus memakai URL project Supabase resmi; custom Auth domain/proxy belum
didukung validator ini. Pasangan endpoint localhost hanya untuk development lokal.
URL/key server tidak memakai alias NEXT_PUBLIC. Entry runtime ditandai `server-only`.

Migration awal tetap utuh dan merujuk `auth.uid()` dari Supabase. Migration
membuat role NOLOGIN/schema/tabel baru, bukan login aplikasi. PostgreSQL 17 dapat
memberikan membership administratif kepada migrator pembuat role secara otomatis;
itu bukan membership aplikasi. Role migrator/owner DDL ditolak sebagai login aplikasi.
Provisioning login aplikasi serta membership runtime memerlukan otorisasi operator
tersendiri; nama/password login tidak ditanam ke migration. PG14/15 memakai login
NOINHERIT dan membership tanpa ADMIN OPTION; PG16+ juga harus memakai INHERIT FALSE,
SET TRUE pada membership. Guard memakai pg_has_role USAGE dan SET ROLE aktual agar
perbedaan versi tidak memberi jalan bypass. Login/membership/role cloud tidak dibuat
atau diubah oleh aplikasi maupun tugas ini.

Preflight cloud memakai guard yang sama dan tidak menerima kredensial admin untuk
memaksa PASS. Default privileges PUBLIC seperti CREATE pada schema permanen atau
grant ekstra aplikasi perlu ditinjau operator; guard menolaknya tanpa memperbaiki
permission cloud secara otomatis. Metadata catalog/PUBLIC bawaan bukan audit semua
fungsi/extension di seluruh database; audit deployment cloud tetap diperlukan.

Migration awal `202610140001` sudah diterapkan berdasarkan audit cloud. Forward
migration `20261015023734` masih menunggu review/otorisasi penerapan remote: ia
menambah helper dan mengubah 34 policy secara atomik, tanpa menulis ulang data/histori,
memberikan grant auth, atau memprovision login. Deploy migration lebih dahulu, lalu
kode guard baru; bila policy/helper migration belum tersedia, kode baru fail closed.
Kegagalan migration rollback helper/policy/ledger melalui CLI. Setelah commit jangan
mengembalikan policy ke auth.uid() pada cloud yang tidak memiliki USAGE auth; gunakan
forward fix yang direview. Backup dan pemeriksaan drift tetap tugas operator.
Supabase CLI 2.109.1 memiliki transaksi migration + ledger; file SQL tidak boleh
mengandung BEGIN/COMMIT top-level. Atomicity dan recovery ledger orphan dijelaskan
di [CLOUD_VERIFICATION.md](./CLOUD_VERIFICATION.md#atomicity-migration-dan-ledger).
Jangan memperbaiki payload historis, nomor revisi konflik, atau manifest yang salah
secara otomatis. Snapshot v1 tetap memerlukan migrasi ownership/Analysis eksplisit.

## API tanpa worksheet UI

GET views: `projects`, `analyses&projectId=...`, `head&analysisId=...`,
`history&analysisId=...`, `revision`/`replay` dengan analysisId+revisionId,
`runs&analysisId=...`, `latest-run&analysisId=...&profile=INU|SOLAR_BAWAH`.
Head adalah view default. Latest run hanya dikembalikan bila revision masih sama
dengan head. Riwayat run lama tersedia melalui view runs.

POST JSON (`Content-Type: application/json`, maksimal 5 MiB):

```json
{ "operation": "SAVE", "request": { "intent": "SAVE_DRAFT", "expectedRevisionId": null, "mutationId": "<UUID-v4>", "snapshot": "<schema-v2 object>" } }
```

`snapshot` pada contoh di atas adalah placeholder; payload sebenarnya berupa object.
RESTORE memakai request `{analysisId, sourceRevisionId, expectedRevisionId, mutationId,
reason?}`. CALCULATE memakai `{analysisId, revisionId, configuration}` sesuai kontrak
EngineConfiguration; tidak ada policy numerik/unit yang diisi otomatis. Save dan
Calculate adalah aksi eksplisit terpisah. Semua hasil kalkulasi masih preview.

## Verifikasi dan batas

`npm run check`: tes domain/engine/Auth/API dan lint/typecheck. Auth memakai transport
fixture; ini bukan bukti integrasi cloud Supabase Auth.

`npm run test:postgres`: membuat cluster PostgreSQL lokal sementara dengan initdb,
socket privat tanpa TCP, bootstrap fixture fungsi auth.uid, menerapkan migration,
menjalankan acceptance database, menghentikan dan membersihkan cluster. Memerlukan
`initdb`, `pg_ctl`, `postgres`, serta Supabase CLI 2.109.1 di PATH; tidak memakai
DATABASE_URL dan tidak dapat mengubah remote. Tes database default dilewati kecuali
perintah ini dijalankan.

Tes nyata mencakup reload lintas koneksi, race first-save/head, retry, restore/replay,
rollback setelah insert snapshot/revision, RLS, immutable history dan stale run.
Tes CLI juga membuktikan rollback schema/role/tabel + ledger saat kegagalan sebelum
dan sesudah INSERT ledger, serta rekonsiliasi eksplisit orphan tanpa rewrite history.
Supabase Auth live, pooler/TLS cloud dan deployment belum diverifikasi.
Pembacaan history untuk transisi saat ini masih memuat seluruh history Analysis;
pagination/indexed transition planning perlu ditinjau sebelum histori produksi besar.

EV-005, unit/mapping operasional, tarif/pajak, rounding bisnis dan parameter solver
tetap terbuka. Tidak ada perubahan workbook, expected value, solver atau Fase 5.

Referensi: [Supabase Auth user endpoint](https://github.com/supabase/auth/blob/master/_autodocs/api-reference/handlers-user.md),
[Supabase PostgreSQL connection](https://supabase.com/docs/guides/database/postgres-js),
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
