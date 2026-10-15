# Fase 5 — UI workflow acceptance, 2026-10-15

Status: **acceptance teknis preview lulus; acceptance bisnis final BELUM LULUS**.
Fase 4 tetap COMPLETE. Tidak ada deployment atau penulisan fixture ke production.

## Acuan dan batas

Pengguna mengizinkan pembangunan UI yang belum tersedia serta pengujian pada stack
lokal terisolasi. Pengguna memilih menetapkan kebijakan bisnis sebelum finalisasi,
tetapi belum menjawab rincian pada `OPEN_DECISIONS.md`. Karena itu hasil tetap
NONFINAL dan `CONFIRM_RESULT` tetap ditolak. Lulusnya penolakan tersebut bukan
bukti bahwa workflow final operasional sudah selesai.

PRD v1.7-draft §13, spesifikasi worksheet dan invariant tetap menjadi acuan.
EV-005, formula/expected value sumber dan workbook tidak diubah. Formula laba
yang dipakai tes di bawah adalah fixture sintetis eksplisit, bukan tarif/policy AHS.

## Peta implementasi aktual

| Lapisan | Tersambung dan tersedia | Batas/gap |
|---|---|---|
| UI `/` | Login, workbook kosong, Project/Analysis terpisah, vendor, offer, komponen revisi/negosiasi, pilihan manual | Belum berupa grid workbook lengkap; tidak ada default angka proyek |
| Worksheet | Tambah input/formula, edit input/formula, preview otomatis, profil INU/Solar independen | Belum ada impor/default formula workbook, editor agregat, sort/reorder/delete/reset worksheet melalui UI |
| Mapping | Pengguna memilih komponen revisi, target Konversi dan alasan, meninjau kesamaan satuan, lalu mengaktifkan mapping preview | Hanya pin/copy komponen ke O dan mapping dengan satuan sama; tanpa transformasi bisnis tersirat. Pemilihan revisi lain memerlukan penerapan ulang manual |
| API `/api/session` | GET validasi, POST LOGIN/REFRESH, DELETE logout melalui REST Auth resmi | Cookie HttpOnly, SameSite=Strict, Secure pada HTTPS; HTTPS/reverse proxy staging belum diuji |
| API `/api/workbook` | Projects/Analyses/head/history/revision/replay/runs/latest-run; SAVE/RESTORE/CALCULATE | Bearer API lama dipertahankan; sesi cookie ditambahkan dengan guard Origin/Host |
| Repository PostgreSQL | Snapshot, event, histori/run immutable, idempotensi, stale conflict, ownership | Adapter/migration/role production tidak diubah. Regresi memakai cluster lokal sementara |
| Engine | Parser stable ID, decimal BigInt, unit algebra, graph, full/incremental recalculation | UI memanggil engine yang sama; kalkulasi uang tidak ditulis ulang dalam React |
| HPP | INPUT manual tiap profil, pencatatan konteks run, perubahan upstream → NEEDS_REVIEW | Nilai H tidak auto-bind ke O/S/B. Konteks preview tidak mengonfirmasi hasil bisnis |
| Hasil akhir | Preview tersimpan, hasil historis tetap tersedia, finalisasi ditolak dengan pesan | Solver Profit MUE INU, tarif/basis pajak/biaya, fixture bisnis dan syarat CONFIRMED belum tersedia/disahkan |

Komponen `src/ui/foundation-status.tsx` lama tidak lagi dipakai oleh route `/`.
Unit menu saat ini terbatas pada `1`, IDR, L, IDR/L, kg, IDR/kg dengan dimensi
eksplisit. Tidak ada konversi otomatis, liter↔kg, tarif, faktor nol, auto-award,
compliance gate, atau asumsi bahwa penawaran all-in adalah HPP.

## Lingkungan uji

- Node 22.23.3, Next 16.4.0, React 19.3.0, Playwright 1.64.1 dan Chrome lokal headless.
- Production build Next.js berjalan pada port loopback dinamis, bukan `next dev`.
- PostgreSQL 17 sementara memakai harness yang sudah tersedia dan migration yang
  sama tanpa mengedit file migration. URL runtime/kredensial dihasilkan lokal.
- Auth adalah binary resmi Supabase Auth v2.197.0 macOS arm64, bukan mock Auth.
  SHA-256 arsip diverifikasi:
  `3fb7998e7061e2c14f3f9555b1d94d447358c965395728e0d81eac82e0e5868b`.
- Auth menjalankan schema internalnya sendiri pada cluster sementara, dengan
  `search_path=auth`; proxy loopback hanya mengadaptasi prefix `/auth/v1`.
- Dua akun sintetis dibuat pada Auth lokal; token, password dan cookie tidak
  disimpan dalam laporan. Tracing/video otomatis dimatikan.
- `.env` cloud tidak dipakai sebagai target: DATABASE_URL, SUPABASE_URL dan public
  key selalu diganti oleh harness. Tidak ada verifier cloud atau audit ulang
  database production pada pekerjaan ini.
- Setelah suite selesai, aplikasi, Auth, proxy dan cluster dihentikan; database,
  akun/sesi dan log fixture lokal dihapus oleh teardown.

Bootstrap binary uji pada macOS arm64, ke folder sementara:

```sh
curl -fL https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-darwin-arm64.tar.gz -o /private/tmp/procurement-auth-v2.197.0.tar.gz
shasum -a 256 /private/tmp/procurement-auth-v2.197.0.tar.gz
mkdir -p /private/tmp/procurement-auth-v2.197.0
tar -xzf /private/tmp/procurement-auth-v2.197.0.tar.gz -C /private/tmp/procurement-auth-v2.197.0
```

Cocokkan hash di atas sebelum menjalankan binary. `UI_AUTH_BINARY` boleh menunjuk
binary resmi lain yang sudah diverifikasi untuk platform penguji; runtime aplikasi
tidak membaca variabel tersebut.

## Skenario browser dan hasil aktual

`e2e/procurement.spec.ts` menjalankan empat skenario dengan retry 0 dan tanpa SKIP:

1. Tiga vendor, masing-masing penawaran/komponen; negosiasi Vendor A menambah revisi
   2 tanpa mengganti pilihan revisi 1. Pengguna mengaktifkan O→S pada IDR/L untuk
   fixture ini. B dan H tetap input independen. Harga jual 26.000, HPP 20.000 dan
   volume 100 menghasilkan pendapatan 2.600.000, biaya 2.000.000 dan laba 600.000.
   HPP 28.000 mengubah laba menjadi -200.000; reload mempertahankan hasil tersebut.
   Solar menyimpan HPP 18.000 tanpa mengubah INU. Dua tab diuji: Save stale ditolak
   dan draft tab lama tetap ada. Restore menambah revisi baru; revisi/run lama utuh.
   Finalisasi ditolak secara eksplisit. Pengguna B tidak melihat proyek A dan URL
   Analysis A tidak membuka worksheet. Restart proses Next mempertahankan empat
   revisi dan tiga run; koneksi SQL terpisah membaca empat revisi yang sama.
2. Pergantian akun di tab lain menyembunyikan draft akun sebelumnya; login sebagai
   B tidak memunculkan kembali draft A.
3. Password salah, form wajib kosong, loading/disabled, kegagalan Save 503,
   retry dengan mutation ID yang sama, draft saat sesi habis, login ulang akun yang
   sama, refresh setelah access cookie hilang dan logout diuji. Kegagalan storage
   disuntikkan tepat pada satu request untuk menguji pesan/retry; operasi sukses
   berikutnya memakai API/database nyata.
4. Review run sebagai konteks HPP dicatat; perubahan B membuat NEEDS_REVIEW dan
   HPP tidak berubah. Save/reload mempertahankan konteks. Analysis kedua pada
   Project yang sama tidak mewarisi input Analysis pertama.

Screenshot desktop/mobile berada di output Playwright
`apps/web/test-results/procurement-procurement-vi-acd99--user-isolation-and-restart/`.
Keduanya diperiksa secara visual. Viewport mobile 390×844 juga diperiksa tanpa
overflow horizontal; ini bukan audit aksesibilitas WCAG lengkap.

## Bug yang diperbaiki dan regresinya

| Masalah | Perbaikan / bukti |
|---|---|
| Halaman hanya status fondasi; belum ada workflow UI | Route `/` sekarang terhubung ke command domain, API, repository dan engine; empat skenario browser |
| Origin localhost internal Next berbeda dari Host loopback browser sehingga login sah ditolak | Guard membandingkan protokol dan HTTP Host, tetap menolak origin lain; unit test dan login browser nyata |
| Gangguan jaringan Auth salah dilaporkan sebagai input tidak valid | Upstream fetch error menjadi AUTH_UNAVAILABLE; regression test 503 tanpa detail sensitif |
| Label dropdown memuat teks opsi dan sulit dikenali konsisten | Nama aksesibel eksplisit untuk kontrol; tes browser melalui label/role |
| Nomor revisi setelah Restore dapat memakai ulang nomor historis | Nomor berikut memperhitungkan seluruh snapshot histori; batas safe integer tetap diperiksa |
| Login ulang berpotensi membuang draft setelah sesi berakhir | Draft/mutation dipertahankan hanya untuk actor yang sama; browser regression |
| Tab lama dapat tetap menampilkan workspace setelah pergantian akun | Broadcast sesi menyembunyikan workspace; akun lain membersihkan state lama; browser regression |
| Logout setelah access cookie hilang belum mencabut sesi refresh | Refresh server-side sebelum logout; unit test dan GoTrue/browser regression |
| Restore dapat memilih konfigurasi run dari struktur snapshot lain | Pemulihan mengutamakan snapshot sumber Restore dan inventory yang cocok |

Percobaan awal gagal pada sandbox listener, bootstrap Auth lokal (schema migrations,
search_path, default role), guard Origin dan locator aksesibilitas. Harness/kode
diperbaiki dan suite diulang. Kegagalan tersebut tidak diubah menjadi SKIP atau
ditafsirkan sebagai hasil acceptance yang lulus.

## Pemeriksaan dan kesiapan

| Pemeriksaan | Hasil |
|---|---|
| `PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH RUN_POSTGRES_TESTS=1 npm run check` | 244 PASS, 0 FAIL, 0 SKIP, 1 TODO EV-005; lint/typecheck lulus |
| `npm run build` | PASS, route `/`, `/api/session`, `/api/workbook` |
| `PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH npm run test:e2e` | 4 PASS, 0 FAIL, 0 SKIP; production server lokal, Auth dan PostgreSQL nyata |
| `npm audit --omit=dev --json` | 0 runtime vulnerability pada pemeriksaan ini |

`git diff --check`, review perubahan dan whitespace file baru diperiksa terpisah
karena `apps/` dan `docs/` sudah berstatus untracked sebelum pekerjaan. Penghapusan
artefak root dan perubahan `.gitignore` yang sudah ada dipertahankan.

**Staging:** kandidat untuk review/UAT preview; belum siap staging operasional atau
pilot dengan hasil bisnis final. Lingkungan hosting staging, HTTPS/reverse proxy,
policy operasional, solver, kalkulasi/perbandingan vendor yang dikonfigurasi penuh,
dan seluruh matriks PRD T01–T24 belum dibuktikan end-to-end. Tidak ada klaim Fase 5
COMPLETE. Belum ada pengujian browser lintas engine, uji beban UI, pemulihan draft
setelah crash, atau audit aksesibilitas lengkap.

Save dan CALCULATE adalah dua request: snapshot dapat sukses tersimpan sementara
kalkulasi gagal. Draft/config yang belum disimpan tidak tahan crash/reload; UI
memberi peringatan navigasi. Tidak ada bug baru yang diketahui tertinggal pada
empat skenario yang lulus; batas fitur di atas tetap terbuka dan bukan disamarkan
sebagai fitur yang selesai.

Dokumentasi yang digunakan: [Auth REST resmi](https://github.com/supabase/auth/blob/v2.197.0/README.md),
[rilis Auth resmi](https://github.com/supabase/auth/releases/tag/v2.197.0),
dan dokumentasi Next yang terpasang di `node_modules/next/dist/docs/`.
