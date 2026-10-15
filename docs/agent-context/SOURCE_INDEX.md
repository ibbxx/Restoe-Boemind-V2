# Source Index

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

Artefak audit tambahan berada di `docs/audit/`, dan aset visual di `docs/assets/`. Validasi visual tidak menjadi dasar aturan bisnis dalam dokumen ini. Jangan mengubah sumber-sumber di atas tanpa instruksi eksplisit.
