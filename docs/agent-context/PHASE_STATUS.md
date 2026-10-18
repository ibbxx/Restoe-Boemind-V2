# Phase Status

Status diperbarui 2026-10-15. Fase 4 tetap COMPLETE berdasarkan bukti cloud sebelumnya;
Fase 5 dimulai melalui instruksi eksplisit pengguna. Status teknis tidak mengesahkan kebijakan bisnis.

| Fase | Status | Bukti | Batas |
|---|---|---|---|
| 1 | SELESAI/TERINTEGRASI | `apps/web/README.md`, struktur Next app, kontrak dasar dan tes baseline | Tidak berarti seluruh produk bisnis selesai. |
| 2 | SELESAI DENGAN BATASAN | `src/domain/contracts.ts`, `validation.ts`, `commands.ts`, `freshness.ts`, `change-events.ts`, repository in-memory, tes `phase2-*`; `npm run check` dan `npm run build` telah dijalankan pada audit kode | Persistence masih in-memory; formula/solver/DB/UI bukan scope. |
| 3 | ENGINE TERIMPLEMENTASI, HASIL NONFINAL | `src/engine/README.md`, parser/evaluator/graph, tes `phase3-*` | Solver dan kebijakan finalisasi bisnis belum disahkan/diimplementasikan. |
| 4 | COMPLETE | [Verifikasi aktual PostgreSQL 17, migration cloud, runtime, Auth dua pengguna, HTTP API, persistence dan cleanup](./PHASE4_VERIFICATION.md) | Login aplikasi non-admin; seluruh fixture cloud sudah dibersihkan. Tidak mengotorisasi Fase 5. |
| 5 | ACCEPTANCE TEKNIS UI/PREVIEW historis; perubahan UI terbaru belum diuji manual | UI mengikuti gambar acuan; panel Pengaturan workbook kemudian dihapus dan fungsi penting dipindah ke daftar proyek/canvas; lihat [bukti Fase 5](./PHASE5_VERIFICATION.md) | Preview sintetis tersedia. Solver, kebijakan operasional dan finalisasi belum lengkap; belum siap staging operasional/pilot. |

EV-005 tetap TODO. Tidak ada fase berikutnya yang boleh dimulai hanya karena fase sebelumnya berstatus selesai.

File pemulihan bernama `phase6-*` dipakai untuk regresi struktur/editor yang pengguna minta diteruskan. Nama file tersebut bukan pernyataan bahwa seluruh Fase 6 selesai atau keputusan bisnis terbuka telah disahkan.
