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
