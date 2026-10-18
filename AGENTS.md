# Agent Instructions

Sebelum coding atau mengubah arsitektur, wajib baca:

1. [`docs/agent-context/README.md`](docs/agent-context/README.md).
2. Dokumen konteks yang relevan: `BUSINESS_RULES.md`, `ARCHITECTURE.md`, `PHASE_STATUS.md`, `OPEN_DECISIONS.md`, dan `SOURCE_INDEX.md`.
3. [`apps/web/AGENTS.md`](apps/web/AGENTS.md), bila bekerja di `apps/web/`.
4. Sumber asli yang ditunjuk `SOURCE_INDEX.md`; laporan lama hanya konteks.

Bedakan fakta kode/artefak, keputusan pengguna/PRD yang terkonfirmasi, dan keputusan yang belum disahkan. Jangan menebak aturan bisnis atau mengubah sumber asli untuk menutup gap implementasi.

## Invariant wajib

Pertahankan pemilihan offer/revisi manual, Analysis dan Project yang tidak dicampur tanpa keputusan, profil INU dan Solar Bawah independen, HPP Harga Dasar AHS mengikuti Biaya Harga Dasar Konversi profilnya, Harga Jual AHS manual, stable ID, snapshot historis immutable, restore sebagai revisi baru, penolakan stale revision tanpa overwrite/merge, serta tidak ada auto-award atau compliance gate.

## Batas fase

Jangan menjalankan atau memulai fase berikutnya tanpa instruksi eksplisit. Formula engine, dependency graph operasional, solver, database/Supabase, autentikasi, dan UI bukan pekerjaan Fase 2. EV-005 dan formula/expected value tidak boleh diubah.

Perubahan dokumentasi boleh berada di `docs/agent-context/` dan root `AGENTS.md`. Jangan mengubah workbook, dokumen sumber, atau kode aplikasi kecuali tugas secara eksplisit mengizinkannya. Pertahankan `apps/web/AGENTS.md`.

## Verifikasi

Pengguna meminta pengujian aplikasi dilakukan manual oleh pengguna. Jangan membuat atau menjalankan script test, fixture, test runner, atau pengujian browser otomatis. Script pengujian dihapus atas instruksi pengguna. Periksa diff, `git diff --check`, dan status git; jangan mengklaim pengujian lulus jika tidak dijalankan.

UI tetap mengikuti acuan Stitch. Klik sel menampilkan alamat dan formula berukuran normal di formula bar seperti Excel; jangan menaruh label kode kecil di dalam setiap sel. Semua sel Evaluasi Vendor dapat diisi nilai atau rumus pengguna, termasuk Harga Dasar, nama vendor, PPH, label, metadata, total, dan catatan (instruksi terbaru pengguna). PPH tetap kosong/manual pada template awal, tetapi rumus yang dimasukkan pengguna tidak boleh dihapus otomatis. HPP Harga Dasar mengikuti Biaya Konversi, Harga Jual · Harga Dasar AHS diisi manual oleh tim, dan Harga Jual Setelah Pajak dihitung otomatis.
