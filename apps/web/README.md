# Dynamic Procurement Workbook — Fase 5 preview

UI login dan procurement preview memakai domain/revision history, formula engine,
PostgreSQL repository dan API Save eksplisit dengan verifikasi sesi Supabase Auth. Evaluator dan graph dijelaskan
di [engine README](src/engine/README.md); setup storage/Auth/API dan batas verifikasi
di [persistence README](src/persistence/README.md).
Worksheet interaktif tersedia untuk input/formula dan konfigurasi preview eksplisit.
Workbook baru kosong tanpa data/angka contoh. Belum ada solver, finalisasi bisnis,
atau deployment. Bukti dan gap acceptance: [Fase 5](../../docs/agent-context/PHASE5_VERIFICATION.md).

## Menjalankan secara lokal

Gunakan Node.js 22.12+ dalam major 22; environment verifikasi: 22.23.3.

Simpan konfigurasi lokal di `apps/web/.env` (diabaikan Git). Script `dev` dan `start` memuat CA publik Supabase dari
`certs/supabase-prod-ca-2021.crt` sebelum Node dimulai, dengan verifikasi TLS tetap
aktif. Sumber CA: [unduhan resmi Supabase](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt).

```sh
cd apps/web
npm ci
npm run dev
```

Buka http://localhost:3000. Untuk verifikasi dan production server lokal:

```sh
npm run check
npm run build
npm start
```

`check` menjalankan lint dan TypeScript. Seluruh script, fixture, dan runner pengujian otomatis sudah dihapus atas instruksi pengguna; pengujian aplikasi dilakukan manual oleh pengguna.
Build menggunakan Webpack agar pemeriksaan produksi tidak membutuhkan
proses build Turbopack yang membuka listener tambahan pada environment terbatas.
Dev tetap menggunakan Turbopack, dengan root aplikasi eksplisit.

## Batas modul

- `src/domain`: ID UUID v4 bertipe, profil, input/formula/snapshot dan state revisi.
- `src/domain/commands.ts`: vendor/offer per analysis, append dan pilihan revisi manual,
  edit input sesuai scope, switch profil dan reorder tanpa mengganti identitas.
- `src/domain/validation.ts`: parsing runtime schema v2, ID unik, ownership/referensi,
  membership, scope profil dan sumber HPP di AHS. Field tak dikenal ditolak.
- `src/domain/snapshots.ts`: capture terpisah dari draft, deep freeze, JSON canonical,
  draft dan proposed preview yang belum dievaluasi.
- `src/engine`: parser/AST, evaluator BigInt decimal, unit algebra, graph/SCC,
  full/incremental recalculation, run manifest dan guard publikasi preview sesuai revision.
- `src/application`: kontrak perintah Save eksplisit; identitas/izin berasal dari server session.
- `src/persistence`: envelope revisi dan repository in-memory; transaksi dan adapter nyata
  tersedia melalui PostgreSQL. Transition planner yang sama dipakai ulang.
- `src/server`: verifikasi Supabase Auth, handler API dan koneksi PostgreSQL server.
- `src/app/api/workbook`: Save/Restore/reload/replay/Calculate dengan Bearer API atau cookie browser.
- `src/app/api/session`: login/refresh/logout Auth REST resmi; cookie HttpOnly.
- `src/ui`: workflow dan presentasi; preview menggunakan FormulaEngine, tanpa aritmetika bisnis React.
- `src/app`: Next.js App Router, layout dan halaman workspace.

Snapshot diparse menjadi objek baru dan dibekukan secara rekursif; perubahan draft
tidak memutasi histori. JSON mengurutkan key objek dan mempertahankan urutan array
historis/display. Schema v2 dan v3 diterima; migrasi v1 memerlukan identitas Analysis
yang eksplisit dan tidak ditebak dari Project. Adapter PostgreSQL menyimpan envelope
yang sama secara atomik; migration dan konfigurasi remote tidak dijalankan otomatis.
Runtime tests membuktikan isolasi mutasi profil, reorder, snapshot immutable,
replay state dan optimistic conflict dalam satu instance in-memory.
Tes Fase 4 terpisah membuktikan transaksi dan konflik lintas koneksi PostgreSQL nyata;
Verifikasi cloud Fase 4 terdokumentasi di [PHASE4_VERIFICATION.md](../../docs/agent-context/PHASE4_VERIFICATION.md);
Fase 5 memakai stack lokal sementara dan tidak mengulang audit cloud.
Valid UUID tidak membuktikan bahwa entitas ada atau pengguna berwenang.
`NUMERIC_TEXT` adalah input mentah, bukan nilai desimal tervalidasi. Format tampilan
tidak berada di engine; evaluated value terpisah dari input dan formula.
HPP menunjuk formula AHS yang mengambil Biaya Harga Dasar dari Konversi profilnya;
Harga Jual AHS tetap INPUT manual. Snapshot lama dengan HPP manual dinormalisasi
ketika dibuka sebagai draft baru; histori revisi lama tidak diubah. Context run
harus ada pada daftar referensi dan sesuai profil.
Reference run memuat snapshot/selection/policy/engine historis; metadata itu bukan
bukti aritmetika. Save memeriksa bahwa snapshot historis dan selection/policy-nya ada.
`UNCONFIGURED` tidak memiliki nilai policy pengganti. Engine membedakan
EMPTY/ZERO/MISSING/INVALID/ERROR; kelayakan nol/negatif per komponen bisnis
tetap memerlukan policy. Numeric policy wajib eksplisit, bukan default uang.

Auth memakai REST Supabase resmi; driver `postgres@3.4.9` dipin dan compatible Node 22.
Tidak ada SDK Supabase, grid besar, decimal library atau API simpan palsu.
Dependency dipin dan lockfile disimpan; Next/React/ESLint dipilih berdasarkan
engine/peer requirements yang diperiksa, lalu diverifikasi dengan checks/build lokal.
Laporan verifikasi fase sebelumnya merupakan bukti historis. File dan perintah pengujian yang disebut di laporan tersebut tidak lagi disertakan dalam checkout ini.
Zod transitif pada ESLint dipin ke 4.6.5, yang memenuhi range peer/dependency
`^3.25.0 || ^4.0.0` dan tersedia pada cache offline; bukan validator aplikasi.
Lisensi: Next/React/ESLint MIT, TypeScript Apache-2.0, postgres Unlicense.
Detail versi ada di package.json/lockfile.
Instalasi memberi peringatan deprecation ESLint 9.39.5. Versi ini memenuhi peer
`eslint-plugin-react@7.37.5` (`^9.7`); ESLint 10 belum memenuhi peer tersebut.
Upgrade lint stack setelah dukungan peer diverifikasi, tanpa force/legacy-peer-deps.

## Kontrak revision/history Fase 2

`save({ intent, expectedRevisionId, mutationId, snapshot }, actorId)` menggunakan
`expectedRevisionId = null` hanya untuk analysis yang belum mempunyai head.
Actor in-memory berasal dari pemanggil tepercaya. Adapter PostgreSQL mengikat actor
ke sesi Supabase yang diverifikasi server dan menerapkan owner RLS.
Revisi usang menghasilkan `CONFLICT / STALE_REVISION`, tanpa overwrite atau merge.
Save sukses menghasilkan ID snapshot/revisi baru, parent revision, waktu simpan,
actor dan mutation ID; histori tidak dapat dimutasi oleh pemanggil.

Retry dengan mutation ID/payload/actor identik mengembalikan revisi yang sama,
termasuk setelah head berubah. Payload atau actor berbeda ditolak sebagai
`IDEMPOTENCY_CONFLICT`. OfferRevision, versi formula dan referensi run yang sudah
tersimpan tidak dapat ditulis ulang dengan ID lama. Perubahan formula harus memakai
version ID baru; grammar Fase 3 terbatas dan pengesahan bisnis tetap terpisah.

`restore({ analysisId, sourceRevisionId, expectedRevisionId, mutationId }, actorId)`
membuat SAVED_DRAFT baru dengan parent head dan provenance revision/snapshot sumber.
Restore tidak mempertahankan status CONFIRMED tanpa kalkulasi otoritatif baru.
`replay(analysisId, revisionId)` memulihkan state historis dari payload tersimpan,
tanpa memakai policy terbaru atau evaluator. Ini bukan replay aritmetika engine.

Project adalah pemilik Analysis; kandidat/vendor dan offer berada di Analysis menurut
PRD v1.7 §4.2/§10. Head, history dan kunci retry memakai analysis ID. Dua analysis
dalam project yang sama tidak berbagi state. Save tidak dapat memindahkan analysis
yang sudah tersimpan ke project lain.

Satu Save/Restore sukses membuat satu ChangeEvent immutable dengan actor, waktu,
project/analysis target, aksi, parent/revision baru, alasan opsional dan snapshot
before/after. Daftar `changes` merangkum perubahan input, offer, selection, profil,
mapping, formula, struktur dan konteks yang benar-benar tersimpan. Ketikan/draft
yang dibatalkan tidak dicatat. Retry identik tidak membuat event baru.

Snapshot menyimpan satu versi saat ini per mapping ID. Versi lama tetap pada snapshot
historis; payload dengan version ID lama tidak dapat ditulis ulang. Parser memeriksa
ID/referensi/scope, unit nonkosong, status dan provenance. Label ACTIVE bukan bukti
validasi transformasi/unit atau hasil final. Engine memakai writer MAPPING eksplisit;
metadata mapping tidak boleh mengambil alih INPUT/FORMULA.

`recordReviewContext` mencatat peninjauan eksplisit per profil terhadap snapshot,
selection, mapping versions dan daftar `inputCellIds` yang ditinjau. Perubahan input
terdaftar, revisi offer terkait, selection, mapping terdaftar, formula profil,
policy atau konteks run HPP menandai STALE/NEEDS_REVIEW tanpa mengganti HPP.
Cabang profil lain, kandidat nonpilihan, input tak terdaftar dan reorder tetap
independen; switch profil hanya memilih state tersimpan. Save juga memeriksa
invalidasi terhadap head. Review baru harus eksplisit; tidak mengonfirmasi hasil
kalkulasi. Referensi mapping versi lama dalam review stale adalah provenance historis.
Engine Fase 3 memperluas invalidasi melalui writer aktif transitif. `reviewRun`
mencatat input yang ditemukan dari graph; perubahan membership/unit/policy engine
diperiksa dengan `assessFreshness`/`refreshReviewContexts`.

LOCAL_DRAFT, PREVIEW, SAVED_DRAFT dan CONFIRMED memiliki discriminant berbeda.
`createPreview` hanya membentuk proposed snapshot dengan `run = null`.
`CONFIRM_RESULT` tetap ditolak sebagai `CONFIRMATION_UNAVAILABLE` tanpa policy finalisasi
bisnis yang disahkan. Hasil engine adalah preview; tidak ada auto-binding penawaran.

Formula membawa `referenceCellIds` deklaratif untuk validasi existence/scope.
Engine memeriksa kecocokan daftar itu dengan AST, membership dan cycle/SCC.
Cross-profile reference ditolak; input SHARED boleh dibaca profil.
Tidak ada policy tarif, unit, rounding, faktor nol atau solver yang dikarang.

Typecheck CLI mengecualikan `.next/dev` agar cache dev/build tidak mendeklarasikan
global route types dua kali. `next typegen` tetap membuat/import type produksi,
dan strict checks serta pemeriksaan deklarasi dependency tetap aktif.

## Sumber dan konflik yang dipertahankan

Baseline sumber tetap di root repository, SHA-256
`efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc`.
166 formula/358 edge adalah guard inventaris audit v0.3, bukan bukti engine benar.
Test hash tidak memakai cache formula dan tidak mengubah workbook.

EV-005 pada `docs/audit/MATRIKS_UJI_FORMULA_PROCUREMENT_v0.1.xlsx`, `Test Cases!D7:F7`,
masih belum disahkan: expected lama D17=22860, audit independen melaporkan 25170
untuk D10=21000. Sumber D11 adalah shared follower `D10*11%`, D12=`D10*7.5%`,
D13=`D10*0.3%`, D14 input 200, D15=`D14*11%`, D17=`SUM(D10:D15)`.
Kasus ini dicatat sebagai `todo`, tidak diberi expected baru agar test lulus.

Invariant pemilihan penawaran manual, HPP mengikuti Biaya Konversi per profil,
Harga Jual manual, profil independen dan MUE hanya INU tetap berlaku.
Policy bisnis unit, komponen O/S/B, biaya/pajak/faktor nol, rounding operasional dan
solver tetap memerlukan keputusan. Fase 4 dan pekerjaan berikutnya memerlukan instruksi.
