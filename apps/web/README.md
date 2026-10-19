# Digital Procurement AHS

Next.js 16.4.0 / React 19.3.0, Node 22, PostgreSQL/Supabase dan postgres.js. Workspace memuat Evaluasi Vendor, Konversi Jagad, dan AHS dalam satu canvas dengan profil INU/Solar Bawah independen.

## Persistence current-only

Satu Project memuat banyak Analysis; satu Analysis mempunyai satu kondisi tersimpan. Save memperbarui row yang sama secara atomik bersama metadata. Tabel aktif: `projects`, `analyses`, `current_workbooks`. Tidak ada histori aplikasi, restore/replay, offer revision, atau arsip hasil kalkulasi.

Workbook menyimpan input, formula aktif, referensi cell stable ID, mapping aktif, offer aktif, pilihan vendor manual, layout, dan konfigurasi engine. Payload database menormalisasi metadata, konfigurasi dan nilai vendor agar tidak diduplikasi. Editor menerima tampilan nilai yang dimaterialisasi; FormulaEngine menghitung preview/cetak di memori.

Conflict guard `expectedVersion` dan retry `mutationId` terakhir dipertahankan. Input hilang, referensi rusak, salah ownership, dan versi tertinggal tetap ditolak. Tidak ada auto-award atau compliance gate.

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
