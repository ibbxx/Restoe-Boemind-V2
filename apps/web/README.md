# Digital Procurement AHS

Next.js 16.4.0 / React 19.3.0, Node 22, PostgreSQL/Supabase dan postgres.js. Workspace memuat Evaluasi Vendor, Konversi Jagad, dan AHS dalam satu canvas dengan profil INU/Solar Bawah independen.

## Persistence current-only

Satu Project memuat banyak Analysis; satu Analysis mempunyai satu kondisi tersimpan. Save memperbarui row yang sama secara atomik bersama metadata. Tabel aktif: `projects`, `analyses`, `current_workbooks`. Tidak ada histori aplikasi, restore/replay, offer revision, atau arsip hasil kalkulasi.

Workbook menyimpan input, formula aktif, referensi cell stable ID, mapping aktif, offer aktif, pilihan vendor manual, layout, dan konfigurasi engine. Payload database menormalisasi metadata, konfigurasi dan nilai vendor agar tidak diduplikasi. Editor menerima tampilan nilai yang dimaterialisasi; FormulaEngine menghitung preview/cetak di memori.

Conflict guard `expectedVersion` dan retry `mutationId` terakhir dipertahankan. Input hilang, referensi rusak, salah ownership, dan versi tertinggal tetap ditolak. Tidak ada auto-award atau compliance gate.

## Kelompok dan uraian AHS

Menu titik tiga pada tiap bagian AHS menyediakan Tambah uraian, Ubah nama, dan Hapus. Pendapatan serta Biaya juga menyediakan Tambah kelompok; satu kelompok berisi beberapa uraian. Kelompok baru dibuat bersama uraian pertama. Semua tambahan hanya berlaku pada profil aktif (SKP atau INU); komponen bawaan tetap dilindungi.

- Informasi Analisis: tambahan berupa Teks atau Angka, ditempatkan sebelum HARGA INCLUDE.
- Pendapatan: tambah uraian pada HARGA JUAL atau kelompok baru. Nilai per liter masuk HARGA INCLUDE dan HARGA JUAL SETELAH PAJAK; hasil × Volume masuk TOTAL PENDAPATAN tepat sekali. Tarif/basis pajak bawaan tidak otomatis berubah.
- Biaya: nilai per liter masuk BIAYA PER LITER; hasil × Volume masuk TOTAL BIAYA. Tambahan biaya lama yang belum masuk penjumlahan baku BIAYA PER LITER diselaraskan sekali saat draft disiapkan; formula kustom tidak diganti. Rumus tambahan yang akan membuat siklus menahan penyelarasan/Simpan/cetak sampai diperbaiki.
- Laba: indikator tambahan berupa Rp, Rp/liter, Persen, atau Angka, ditempatkan setelah indikator bawaan dan sebelum Notes. Angka/rumus indikator tidak otomatis mengubah LABA BERSIH. Persen memakai rasio, misalnya `0,1` atau `=10%` untuk 10%.

Volume uraian Pendapatan/Biaya mengikuti sumber Volume AHS profilnya. Penghapusan melepas kontribusi agregat dan ditolak bila masih dipakai rumus lain, mapping, atau agregat. Nama kosong/duplikat ditolak. Metadata opsional `ahsGroups` kini mengenali bagian; kelompok lama tanpa `section` tetap berarti Biaya. Metadata `ahsFields` menyimpan referensi sel dan jenis nilai Informasi/Laba. Seluruhnya berada dalam payload current dengan stable ID, tanpa tabel, endpoint, dependency, atau migration baru; layout legacy tetap didukung.

Tes mencakup kalkulasi penuh/incremental, hitung tepat sekali, perbaikan draft lama, isolasi bagian/profil, validasi, ubah/hapus, encode/decode, serta Save berulang/reload melalui PostgreSQL lokal sementara untuk kedua layout. Browser, fokus dialog, tata letak sel gabungan dan keterbacaan cetak tetap diperiksa manual; AHS yang panjang mengikuti batas penyusutan cetak yang sudah ada.

## Menjalankan

Konfigurasi melalui `.env` di direktori ini. Pertahankan permission 0600 dan CA TLS; jangan memakai koneksi operator sebagai login runtime.

```sh
npm run dev
npm run check
npm run build
npm test
```

Tes persistence membutuhkan PostgreSQL 17 lokal; `PG_BIN` opsional. Harness memakai cluster sementara, data sintetis dan login terbatas. Tidak mengakses cloud atau `.env`.

Pembersihan setelah refactor menghapus editor/fondasi lama, repository in-memory dan kontraknya, wrapper worker solver tanpa pemanggil, serialisasi arsip, helper yang tidak dipakai, serta CSS editor lama. Solver aktif tetap melalui FormulaEngine. Tidak ada dependensi paket khusus histori yang tersisa. Tes juga mencakup penolakan operasi histori lama, hubungan HPP–Biaya, harga jual manual, PPN volume besar, dan pilihan/volume profil independen setelah Save/reload.

## Diagnosis waktu loading dan Simpan

`vercel.json` mengarahkan Vercel Functions ke satu region Singapore (`sin1`), dekat dengan database Supabase Singapore. File berada di root aplikasi Next.js (`apps/web`); Vercel Root Directory harus menunjuk folder ini. Konfigurasi berlaku pada deployment berikutnya, bukan server localhost. Runtime tetap Node.js; tidak memakai `preferredRegion` yang deprecated, mengubah pool/timeout, atau menambahkan layanan berbayar. Setelah deployment, periksa `x-vercel-id` pada `/api/session` dan `/api/workbook?view=projects` untuk mengonfirmasi region eksekusi; kode HTTP 401 tanpa sesi pada workbook tetap benar. Header lokasi saja tidak membuktikan performa alur login/data sudah baik.

GET workbook mengembalikan `analysisMetadata` (nama, status, versi) dari SELECT yang sama dengan workbook. Editor tidak lagi menunggu request daftar analisis kedua. Kontrak Simpan serta `repository.current()` tetap sama; tidak ada migration untuk perubahan ini.

Setelah sesi valid, URL langsung Analysis mengambil workbook dan daftar Project secara paralel. Worksheet siap tanpa menunggu daftar Project; navigasi kembali ke Project tetap menunggu daftar akses bila request itu belum selesai. Kegagalan request latar belakang dilaporkan tanpa membuang worksheet, sedangkan sesi tidak valid tetap menutup akses. Animasi logo dan blur layar penuh tetap memakai tampilan semula saat loading, Simpan, dan persiapan cetak; tidak ada loader inline atau banner baru yang mengubah layout. Pesan kosong tidak ditampilkan sebelum request selesai.

Simpan tetap menampilkan animasi/blur dengan label `Menyimpan perubahan…`, sementara edit, navigasi, dan Save ulang dikunci sampai request selesai. Status sukses hanya muncul sesudah respons commit. Kalkulasi transient dijadwalkan setelah kesempatan paint, memakai status aksesibel terpisah tanpa banner tambahan, membuang pekerjaan yang sudah digantikan, dan tidak memakai hasil snapshot sebelumnya. Cetak menunggu kalkulasi terbaru, termasuk bila blur saat mencetak baru mengonfirmasi input. Ini bukan Worker: perhitungan tetap memakai thread browser dan FormulaEngine yang sama, tanpa mengubah formula/presisi. Kalkulasi tidak memperpanjang loader Simpan.

Daftar Project dan halaman Analysis memakai cache metadata di memori tab selama 30 detik, maksimal 20 halaman Analysis dengan eviksi LRU. Kunci mencakup aktor sesi dan URL daftar (proyek, pencarian, status, periode, cursor, limit); ini bukan pemisahan data database per akun. Kembali ke daftar yang pernah dimuat langsung menampilkan cache tanpa menyalakan loader. Cache segar tidak melakukan request lagi; cache kedaluwarsa tetap tampil sambil diperbarui di belakang layar. Tab yang kembali aktif mengecek daftar aktif yang kedaluwarsa, tanpa polling. Request daftar identik yang sedang berjalan digabung.

Save/rename/status/hapus yang sudah dikonfirmasi server menginvalidasi cache halaman proyek terkait; pembuatan/penghapusan Project juga menginvalidasi daftar Project. Respons sebelum invalidasi tidak boleh mengisi ulang cache atau menimpa daftar terbaru. Penghapusan Analysis tidak lagi mengambil ulang daftar Project. Gagal jaringan mempertahankan daftar terakhir dan memakai pesan error yang sudah ada; sesi ditolak tetap meminta login dan membersihkan cache. Logout/pergantian sesi membatalkan request serta membersihkan cache, termasuk ketika login ulang ke akun yang sama. Workbook, hasil autentikasi, dan draft tidak dicache oleh mekanisme ini; HTTP tetap `no-store`, tanpa localStorage, IndexedDB, CDN cache atau perubahan database.

Di DevTools Network, periksa `Server-Timing` pada `/api/workbook`:

- `auth`: validasi sesi ke Supabase Auth.
- `db_connect`: menunggu pool, pembentukan koneksi bila diperlukan, dan BEGIN.
- `db_setup`, `db_identity`, `db_role`, `db_privileges`, `db_claims`: pemeriksaan keamanan per transaksi.
- `db_query`, `decode`, `stored_validation`: pembacaan dan validasi workbook; daftar proyek/analisis hanya mempunyai tahap query.
- `validation`, `encode`, `db_write`, `persistence`: tahap Simpan, bila dijalankan.
- `db_finish`: COMMIT/ROLLBACK; `serialize`: pembentukan respons JSON; `total`: handler sesudah mulai berjalan.

`db_transaction` dan `persistence` mencakup tahap-tahap di dalamnya, sehingga jangan menjumlahkan semua metrik. `total` tidak mencakup cold start sebelum handler, transfer respons ke browser, atau rendering browser. Durasi query mencakup perjalanan jaringan, bukan hanya eksekusi SQL. Pemeriksaan keamanan tidak di-cache atau dilewati.

Durasi browser tersedia sebagai User Timing berawalan `procurement:` di panel Performance. Tersimpan hanya sampel terakhir per tahap, tanpa isi workbook, ID, URL atau token. Untuk melihatnya melalui Console:

```js
console.table(performance.getEntriesByType("measure")
  .filter(entry => entry.name.startsWith("procurement:"))
  .map(entry => ({ tahap: entry.name, milidetik: entry.duration.toFixed(1) })));
```

`normalize` mengukur penyiapan workbook; `calculation` mengukur FormulaEngine; `load` berakhir ketika state siap ditampilkan. `worksheet-render` dan `save-render` berakhir setelah dua animation frame sesudah commit React, sebagai perkiraan waktu tampilan siap. `save-input`, `save-serialize`, `save-request`, `save-response` memisahkan konfirmasi input, serialisasi request, HTTP beserta parsing respons, dan pembaruan state. `save` mencakup seluruh alur Simpan sebelum rendering berikutnya.

Pemeriksaan manual: bandingkan akses pertama dan berulang untuk buka proyek, buka analisis dan Simpan. Gunakan kondisi jaringan/perangkat yang sama, catat median dan rentang dari sedikitnya lima percobaan sebelum/sesudah; jangan menyamakan hasil lokal dengan Vercel. Pembukaan analisis hanya mengambil satu request workbook, tanpa request metadata tambahan; perlambat request daftar proyek untuk memastikan worksheet tidak ikut tertahan. Uji Simpan saat kursor masih berada pada input terakhir, Simpan tanpa perubahan, reload, konflik dua akun/tab, retry, navigasi lambat dan pergantian sesi; pastikan status/nilai/formula tidak berubah. Pengukuran aktual Vercel serta penerimaan visual tetap dilakukan setelah deployment.

Verifikasi cache melalui Network: buka daftar Analysis, buka workbook lalu kembali tanpa perubahan dalam 30 detik; tidak ada request daftar tambahan atau loader baru. Setelah 30 detik, kembali/fokus tab menampilkan daftar lama sambil melakukan satu request per daftar kedaluwarsa. Filter/cursor yang belum pernah dibuka tetap memakai animasi/blur semula. Setelah perubahan tersimpan, daftar terkait diambil ulang; respons tertunda dari filter/sesi lama tidak boleh menimpa tampilan. Cache hilang saat tab direload dan tidak menjamin perubahan akun lain langsung terlihat sebelum navigasi/fokus berikutnya.

Gerbang rilis: verifikasi kecocokan schema dan RLS cloud dengan akses bersama yang digunakan kode, khususnya migration `20261021073232_shared_workspace_data.sql`. Jangan menjalankan seluruh migration secara membabi buta atau menerapkan perubahan cloud otomatis saat startup. Penerapan cloud memerlukan persetujuan operator terpisah serta backup/verifikasi; perubahan loading ini tidak mengubah schema atau policy.

## Cutover

Migration `supabase/migrations/20261019071911_current_only_procurement.sql` baru dibuat dan diverifikasi lokal, belum diterapkan ke cloud. Migration tersebut mempertahankan current Analysis dan menghapus arsip lama secara fisik dalam transaksi. Hentikan writer lama sebelum penerapan operator; jangan menjalankan aplikasi baru terhadap schema lama. Aplikasi tidak melakukan migration saat startup.

Lihat `src/persistence/README.md` untuk API/RLS, `src/engine/README.md` untuk kalkulasi, dan `../../docs/agent-context/PERSISTENCE_CURRENT_ONLY_AUDIT.md` untuk laporan perubahan serta verifikasi. Dokumen PRD/workbook dan expected value EV-005 tidak diubah.

## Komponen ikon menu

`src/components/ui/menu-toggle-icon.tsx` menyimpan ikon menu animasi; `demo.tsx` di folder yang sama menyediakan contoh pemakaian. Folder ini menjadi tempat komponen UI yang dapat digunakan ulang, terpisah dari orkestrasi worksheet di `src/ui`. Style tetap di `src/app/globals.css`. Ikon memakai CSS biasa yang setara dengan contoh Tailwind, tanpa dependensi tambahan atau provider. Prop `open` mengikuti event `toggle` menu native, termasuk ketika menu ditutup lewat Escape, klik di luar, atau pemilihan aksi. Tombol AHS berukuran 20 px tanpa border, dengan ikon 14 px.

TypeScript sudah tersedia. Tailwind dan konfigurasi shadcn belum dipasang. Bila proyek kemudian memakai komponen shadcn lain, penyiapannya adalah:

1. Jalankan `npm install -D tailwindcss @tailwindcss/postcss`.
2. Buat `postcss.config.mjs` dengan `export default { plugins: { '@tailwindcss/postcss': {} } };`.
3. Tambahkan `@import 'tailwindcss';` pada awal `src/app/globals.css`. Tinjau reset bawaan Tailwind terhadap tabel dan form yang sudah ada.
4. Tambahkan `"paths": { "@/*": ["./src/*"] }` pada `compilerOptions` di `tsconfig.json`.
5. Jalankan `npx shadcn@latest init -d`, lalu pastikan `components.json` menunjuk style ke `src/app/globals.css` dan alias UI ke `@/components/ui`. Tinjau perubahan CSS hasil CLI sebelum digunakan.

Panduan tersebut belum dijalankan karena ikon ini sudah berfungsi dengan CSS proyek. Acuan: [instalasi resmi shadcn](https://ui.shadcn.com/docs/installation/next) dan panduan CSS Next.js yang disertakan pada `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`.
