# Source Index

Audit implementasi terbaru: [Editor rumus seluruh sel Evaluasi Vendor](./EVALUASI_VENDOR_FORMULA_AUDIT.md). Laporan ini mencatat inspeksi kode, perubahan, dan batas verifikasi; bukan pengesahan angka bisnis atau pengganti sumber asli.

Path berikut diperiksa dalam audit. Versi adalah versi yang tertulis di artefak; bila tidak tertulis, dicatat sebagai tidak dinyatakan.

| Sumber | Versi/status | Peran |
|---|---|---|
| `PRD_SISTEM_EVALUASI_VENDOR_KONVERSI_JAGAD_AHS.md` | v1.7-draft, 2026-10-14 | Acuan produk utama |
| `SPESIFIKASI_WORKSHEET.md` | Isi merujuk v1.7; versi eksplisit tidak dinyatakan pada nama file | Kontrak worksheet, H manual, freshness, event, mapping |
| `FLOWCHART_PROSES_BISNIS.md` | Tidak dinyatakan | Alur bisnis dan boundary |
| `FLOWCHART_PERHITUNGAN_AHS.md` | Tidak dinyatakan | Alur AHS; bukan izin memulai engine |
| `AHAS Sistem.xlsx` | Workbook sumber; versi file tidak dinyatakan | Artefak sumber formula/struktur |
| `docs/audit/BASELINE_FORMULA_AUDIT.md` | Audit artefak; versi dokumen tidak dinyatakan | Bukti audit workbook |
| `docs/audit/ANALISIS_MENDALAM_AHAS_SKP_DINAR_TERBARU.md` | Audit artefak; versi dokumen tidak dinyatakan | Bukti reverse engineering |
| `apps/web/README.md` | Fase 2 foundation | Batas implementasi aktual |
| `apps/web/package.json` | Next 16.4.0 / React 19.3.0 | Stack dan script |
| `apps/web/src/domain/*.ts` | Kode aktual schema v2 | Kontrak, command, freshness, event |
| `apps/web/tests/phase2-*.test.ts` | Tes aktual | Bukti acceptance Fase 2 |
| `apps/web/src/engine/README.md`, `apps/web/tests/phase3-*.test.ts` | Engine aktual | Parser/evaluator/graph dan batas NONFINAL |
| `docs/agent-context/PHASE4_VERIFICATION.md` | COMPLETE, 2026-10-15 | Bukti cloud Fase 4; tidak diaudit ulang di Fase 5 |
| `apps/web/src/ui/procurement-workspace.tsx`, `apps/web/src/domain/workflow.ts` | UI Fase 5 | Workflow preview, pilihan/mapping manual, HPP, histori |
| `apps/web/e2e/procurement.spec.ts`, `apps/web/tests/phase5-*.test.ts` | Acceptance teknis | Browser nyata dan regression test sesi/workflow |
| `docs/agent-context/PHASE5_VERIFICATION.md` | Bukti Fase 5 | Hasil aktual, gap bisnis dan kesiapan staging |
| `docs/assets/image.png` | Referensi visual pengguna | Susunan, dimensi, border, font dan warna; bukan sumber kebijakan pajak/angka proyek |
| `apps/web/src/ui/worksheet-surface.tsx`, `worksheet-editor.tsx`, `sheet-editor.tsx`, `sheet-grid.ts` | UI aktual | Worksheet acuan, toolbar formula/struktur, merge dan grid tambahan |
| `apps/web/src/domain/structure.ts`, `apps/web/tests/phase6-*.test.ts`, `apps/web/e2e/worksheet-editor.spec.ts` | Artefak yang dipulihkan dan diintegrasikan | Stable ID, merge/split, perubahan struktur/formula dan persistensi browser |

Artefak audit tambahan berada di `docs/audit/`, dan aset visual di `docs/assets/`. Validasi visual tidak menjadi dasar aturan bisnis dalam dokumen ini. Jangan mengubah sumber-sumber di atas tanpa instruksi eksplisit.

## Integrasi Stitch 2026-10-16

- Acuan visual terpilih: Stitch project `8591054839130643709`, screen
  `0cbb4b678dc24fde816ae2403d23dd5a`, “Dashboard AHS & Evaluasi Vendor (A4 Landscape Print-Ready)”.
- Implementasi: `apps/web/src/ui/worksheet-surface.tsx`, stylesheet aplikasi,
  workflow template dan engine yang sudah ada; bukan sumber tarif atau angka bisnis baru.
- Kompatibilitas storage: `apps/web/supabase/migrations/202610160001_dynamic_workbook_snapshots.sql`.
- Regresi: `apps/web/e2e/stitch-workspace.spec.ts`, `apps/web/tests/phase6-integration.test.ts`,
  dan tambahan pengujian schema v3 pada `apps/web/tests/phase4-postgres.test.ts`.
