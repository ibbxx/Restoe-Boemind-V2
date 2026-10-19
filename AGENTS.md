# Agent Instructions

Sebelum coding atau mengubah arsitektur, wajib baca:

1. [`docs/agent-context/README.md`](docs/agent-context/README.md).
2. Dokumen konteks yang relevan: `BUSINESS_RULES.md`, `ARCHITECTURE.md`, `PHASE_STATUS.md`, `OPEN_DECISIONS.md`, dan `SOURCE_INDEX.md`.
3. [`apps/web/AGENTS.md`](apps/web/AGENTS.md), bila bekerja di `apps/web/`.
4. Sumber asli yang ditunjuk `SOURCE_INDEX.md`; laporan lama hanya konteks.

Bedakan fakta kode/artefak, keputusan pengguna/PRD yang terkonfirmasi, dan keputusan yang belum disahkan. Jangan menebak aturan bisnis atau mengubah sumber asli untuk menutup gap implementasi.

## Invariant wajib

Pertahankan pemilihan vendor/offer manual, Analysis dan Project yang tidak dicampur tanpa keputusan, profil INU dan Solar Bawah independen, HPP Harga Dasar AHS mengikuti Biaya Harga Dasar Konversi profilnya, Harga Jual AHS manual, stable ID, penolakan simpan dari versi tertinggal tanpa overwrite/merge, serta tidak ada auto-award atau compliance gate.

Keputusan pengguna 2026-10-19: setiap Analysis hanya mempunyai satu kondisi tersimpan beserta konfigurasi perhitungan. Tidak ada revisions, change events, offer revisions, workbook archive atau calculation history. Pengguna mengizinkan penghapusan fisik histori lama melalui migration baru. Tabel aktif hanya projects, analyses, current_workbooks; offer/formula/mapping aktif berada dalam satu payload, tanpa duplikasi konfigurasi/nilai vendor. Hasil engine bersifat sementara. Token versi dan mutation ID terakhir adalah pengaman konflik/retry, bukan histori. Migration hanya dibuat dan diverifikasi lokal sesuai pilihan pengguna; penerapan cloud belum diizinkan. Jangan menjalankan migration otomatis saat startup.

## Batas fase

Jangan menjalankan atau memulai fase berikutnya tanpa instruksi eksplisit. Formula engine, dependency graph operasional, solver, database/Supabase, autentikasi, dan UI bukan pekerjaan Fase 2. EV-005 dan formula/expected value tidak boleh diubah.

Perubahan dokumentasi boleh berada di `docs/agent-context/` dan root `AGENTS.md`. Jangan mengubah workbook, dokumen sumber, atau kode aplikasi kecuali tugas secara eksplisit mengizinkannya. Pertahankan `apps/web/AGENTS.md`.

## Verifikasi

Instruksi terbaru untuk refactor persistence secara eksplisit meminta tes Save berulang, reload dan ketiadaan histori. Tes domain/API/PostgreSQL lokal terisolasi diizinkan untuk pekerjaan ini; jangan memakai cloud sebagai target sintetis. Pengujian browser/visual tetap manual oleh pengguna. Periksa diff, `git diff --check`, dan status git; jangan mengklaim pengujian lulus jika tidak dijalankan.

UI tetap mengikuti acuan Stitch. Klik sel menampilkan alamat dan formula berukuran normal di formula bar seperti Excel; jangan menaruh label kode kecil di dalam setiap sel. Semua sel Evaluasi Vendor dapat diisi nilai atau rumus pengguna, termasuk Harga Dasar, nama vendor, PPH, label, metadata, total, dan catatan (instruksi terbaru pengguna). PPH tetap kosong/manual pada template awal, tetapi rumus yang dimasukkan pengguna tidak boleh dihapus otomatis. HPP Harga Dasar mengikuti Biaya Konversi, Harga Jual · Harga Dasar AHS diisi manual oleh tim, dan Harga Jual Setelah Pajak dihitung otomatis.
