# Agent Instructions

Sebelum coding atau mengubah arsitektur, wajib baca:

1. [`docs/agent-context/README.md`](docs/agent-context/README.md).
2. Dokumen konteks yang relevan: `BUSINESS_RULES.md`, `ARCHITECTURE.md`, `PHASE_STATUS.md`, `OPEN_DECISIONS.md`, dan `SOURCE_INDEX.md`.
3. [`apps/web/AGENTS.md`](apps/web/AGENTS.md), bila bekerja di `apps/web/`.
4. Sumber asli yang ditunjuk `SOURCE_INDEX.md`; laporan lama hanya konteks.

Bedakan fakta kode/artefak, keputusan pengguna/PRD yang terkonfirmasi, dan keputusan yang belum disahkan. Jangan menebak aturan bisnis atau mengubah sumber asli untuk menutup gap implementasi.

## Invariant wajib

Pertahankan pemilihan offer/revisi manual, Analysis dan Project yang tidak dicampur tanpa keputusan, profil INU dan Solar Bawah independen, HPP AHS manual tanpa auto-binding, stable ID, snapshot historis immutable, restore sebagai revisi baru, penolakan stale revision tanpa overwrite/merge, serta tidak ada auto-award atau compliance gate.

## Batas fase

Jangan menjalankan atau memulai fase berikutnya tanpa instruksi eksplisit. Formula engine, dependency graph operasional, solver, database/Supabase, autentikasi, dan UI bukan pekerjaan Fase 2. EV-005 dan formula/expected value tidak boleh diubah.

Perubahan dokumentasi boleh berada di `docs/agent-context/` dan root `AGENTS.md`. Jangan mengubah workbook, dokumen sumber, atau kode aplikasi kecuali tugas secara eksplisit mengizinkannya. Pertahankan `apps/web/AGENTS.md`.

## Verifikasi

Untuk perubahan yang diizinkan, periksa diff, `git diff --check`, status git, dan tes/lint/typecheck/build yang relevan. Jangan mengklaim perintah lulus jika belum dijalankan.
