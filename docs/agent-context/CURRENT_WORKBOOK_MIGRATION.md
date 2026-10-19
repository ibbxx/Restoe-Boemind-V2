# Kondisi terbaru per Analysis

Keputusan pengguna 2026-10-19: tidak menyimpan histori revisi atau arsip hasil hitung baru. Kode runtime dan database aktif sudah memakai satu kondisi terbaru sejak migrasi `20261019035326_current_workbooks_with_latest_data`. Dokumentasi PRD/README/verifikasi lama yang menyebut histori adalah baseline sebelumnya, bukan kontrak runtime terbaru.

## Bukti penerapan cloud 2026-10-19

- Target dikonfirmasi dari konfigurasi aplikasi: proyek Supabase `lvogjvwrohdszgknlplg` (`restubumind`, ap-southeast-1).
- Migrasi `20261019035326_current_workbooks_with_latest_data` berhasil melalui operator MCP; DDL, pencabutan hak arsip, dan backfill dikomit dalam satu transaksi. Source-head/hash diperiksa di dalam lock sebelum perubahan. Tidak ada jeda tabel current kosong yang dibuka ke runtime.
- Satu Analysis mempunyai current workbook; jumlah head yang belum dipindahkan nol. Semua 268 sel serta array formula identik dengan sumber. Konfigurasi aktif 18 desimal HALF_UP EVERY_OPERATION, referensi hasil historis kosong.
- Jumlah arsip tetap 30 revisi dan 21 run. Tidak ada penghapusan fisik atau penggantian kredensial aplikasi. Data sumber, konfigurasi yang cocok, ACL sebelumnya, dan SQL penerapan disimpan dalam folder privat lokal `/private/tmp/procurement-current-migration-bjmbkx2l`; ini cadangan sumber migrasi, bukan dump penuh database.
- Koneksi nyata dari `apps/web/.env` dengan TLS verify-full berhasil melewati `enterRuntimeRole`: role procurement_runtime, SELECT current true, UPDATE snapshot current true, SELECT revisions false, RLS current aktif. Pemeriksaan ini baca-saja; tidak melakukan simulasi Simpan atau login pengguna.
- Security advisor sebelum/sesudah mempunyai tiga peringatan yang sama, tidak ada temuan baru dari tabel current. Peringatan baseline tentang [fungsi SECURITY DEFINER yang bisa dipanggil anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [akses fungsi oleh authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), dan [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) tidak diubah karena berada di luar migrasi ini.
- Tidak menjalankan pengujian aplikasi/browser otomatis; pengguna memeriksa buka, edit, Simpan, cetak, dan konflik dua tab secara manual.

## Yang disimpan

`procurement.current_workbooks` mempunyai satu baris per Analysis: snapshot, konfigurasi penuh, UUID versi teknis, waktu/pengguna penyimpan, mutation ID terakhir, dan signature SHA-256. Konfigurasi disimpan bersama snapshot; legacy v2 tidak lagi bergantung pada CALCULATE yang berhasil. Hasil perhitungan tidak ditulis ke database. Vendor mempunyai satu set nilai aktif per offer; nama field schema legacy bukan koleksi histori lagi. Snapshot di memori tetap dipisahkan/deep freeze agar draft tidak memutasi data acuan.

GET `/api/workbook?analysisId=...` atau `view=current` mengembalikan `{ snapshot, configuration, version, savedAt, savedBy }` atau null. `view=projects` dan `view=analyses` tetap tersedia. POST hanya mendukung `SAVE` dengan `{ snapshot, configuration, expectedVersion, mutationId }`. Respons sukses adalah `{ status: "SAVED", workbook }`; konflik adalah HTTP 409 `STALE_VERSION`. Endpoint histori/revisi/replay/run dan operasi RESTORE/CALCULATE sudah dihapus.

Token versi berubah pada setiap penyimpanan baru. Permintaan memakai versi yang dibaca sebelumnya; server menolak versi tertinggal. Retry mutation terakhir dengan signature sama tidak menulis ulang data. Signature berbeda ditolak sebagai `IDEMPOTENCY_CONFLICT`. Retry yang sudah tertinggal oleh penyimpanan lain mendapat konflik, tanpa ledger histori. Kegagalan request tidak membuang draft; tidak ada pemulihan draft setelah browser ditutup/crash.

## Cutover operator — bukan startup aplikasi

1. Siapkan backup database melalui mekanisme operator yang berlaku. Hentikan semua instance/penulisan aplikasi lama dan tetap tutup akses pengguna sampai seluruh langkah selesai. Jangan mengganti login runtime dengan login administratif.
2. Terapkan file `apps/web/supabase/migrations/20261019035326_current_workbooks_with_latest_data.sql` pada target yang sudah dipastikan benar melalui workflow migrasi operator. File membuat tabel/kebijakan RLS dan mencabut akses runtime ke tabel arsip; tidak menghapus arsip. Ini tidak dijalankan oleh aplikasi.
3. Dari `apps/web`, sediakan `PROCUREMENT_MIGRATION_DATABASE_URL` melalui environment proses operator, dengan koneksi TLS yang berwenang membaca semua owner. Jangan menuliskan URL itu ke `.env` aplikasi atau commit, dan jangan menampilkannya dalam log.
4. Jalankan `npm run migrate:current-workbooks`. Perintah menggunakan CA yang sama, mengambil lock tabel selama transaksi, membaca hanya head terakhir dan metadata konfigurasi legacy yang diperlukan. Unit/agregat/policy dipulihkan sebelum kebijakan operasional 18 desimal yang telah disahkan diterapkan. Tidak ada perhitungan uang baru dalam migrator. Konfigurasi yang tidak dapat dicocokkan menghentikan transaksi, bukan menebak metadata. Snapshot/formula dibandingkan sebelum INSERT; kesalahan membatalkan seluruh backfill. Keluaran hanya jumlah lembar atau pesan gagal tanpa detail koneksi.
5. Perintah dapat diulang: baris current yang sudah ada tidak ditimpa. Pastikan setiap head lama mempunyai baris current dengan owner yang sama. Cabut environment koneksi operator setelah selesai, kemudian jalankan aplikasi baru menggunakan login terbatas yang tetap ada di `apps/web/.env`.
6. Pengguna memeriksa lembar dan alur di bawah sebelum akses dibuka kembali. Jangan menjalankan kembali aplikasi lama setelah ada penyimpanan baru: arsip lama tidak mengikuti perubahan di tabel current.

Tidak ada fallback runtime yang membaca arsip apabila current kosong. Jika skema belum tersedia, aplikasi menyampaikan bahwa pembaruan penyimpanan belum selesai. Apabila backfill gagal, pertahankan maintenance dan perbaiki sumber/konfigurasi melalui operator; jangan buka aplikasi baru dengan data setengah pindah.

## Penerimaan manual oleh pengguna

- Buka proyek existing dan proyek baru; satu pembacaan workbook mencukupi, tanpa history/runs/CALCULATE.
- Ubah input, formula, nama vendor, uraian, volume, dan harga jual; Simpan lalu buka ulang. Nilai, satuan, konfigurasi, pilihan vendor, serta struktur tetap sesuai.
- Simpan berulang pada Analysis yang sama tidak menambah jumlah baris current; tidak menambah baris pada tabel arsip lama. Dua Analysis/profil tidak saling menimpa.
- Buka dua tab dari versi sama. Simpan tab pertama lalu tab kedua: tab kedua mendapat konflik dan draft tetap ada. Klik ganda/retry terakhir tidak menggandakan penyimpanan.
- Gangguan jaringan/timeout mempertahankan input yang belum disimpan dan tidak menampilkan status Tersimpan sebelum commit berhasil.
- Contoh INU: Biaya/HPP 21.878,80; Profit MUE internal 50,00034; PPN/liter 2.406,668 × 5.000.000 = Rp 12.033.340.000. Profil Solar, formula pengguna, pilihan vendor manual, dan cetak tetap diperiksa terpisah.
- Data akun lain tetap tidak bisa dibaca/diubah. Runtime hanya berhak pada projects, analyses, dan current_workbooks; arsip tidak dapat diakses oleh login runtime.

## Batas

Tidak tersedia restore ke versi sebelum Simpan terakhir. Tabel lama tidak dipangkas/dihapus, sehingga ukuran fisik database lama belum menyusut. UPDATE masih menghasilkan versi baris internal PostgreSQL sampai pemeliharaan normal berjalan; satu kondisi logis bukan jaminan nol pertumbuhan fisik. Penghematan ukuran/latensi belum diukur. Pengujian aplikasi/browser tidak dijalankan otomatis sesuai instruksi pengguna. Penerapan migrasi nyata serta query pemeriksaan integritas/hak akses dilakukan setelah izin eksplisit pengguna; ini bukan bukti pengujian perilaku aplikasi.
