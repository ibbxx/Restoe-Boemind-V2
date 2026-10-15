# Agent Context

Dokumen ini adalah indeks operasional untuk pekerjaan Dynamic Procurement Workbook. Baca sebelum coding atau perubahan arsitektur.

## Hierarki acuan

1. Invariant dan instruksi pengguna yang terkonfirmasi.
2. PRD v1.7-draft dan spesifikasi v1.7 yang dirujuk di [SOURCE_INDEX.md](./SOURCE_INDEX.md).
3. Bukti artefak sumber (workbook, flowchart, dan audit) — fakta, bukan izin untuk mengubah aturan.
4. Implementasi aktual dan tes di `apps/web/`.
5. Laporan lama hanya konteks; tidak boleh mengalahkan acuan di atas.

## Peta dokumen

- [BUSINESS_RULES.md](./BUSINESS_RULES.md): aturan terkonfirmasi dan invariant.
- [ARCHITECTURE.md](./ARCHITECTURE.md): stack serta batas arsitektur aktual.
- [PHASE_STATUS.md](./PHASE_STATUS.md): status Fase 1–5 berdasarkan kode dan tes.
- [OPEN_DECISIONS.md](./OPEN_DECISIONS.md): hal yang belum disahkan; jangan ditebak.
- [SOURCE_INDEX.md](./SOURCE_INDEX.md): lokasi dan versi sumber.

File agent yang wajib dibaca: [root AGENTS.md](../../AGENTS.md) dan [`apps/web/AGENTS.md`](../../apps/web/AGENTS.md).

## Cara membaca status

`FAKTA` berasal dari file/kode yang dapat diperiksa. `TERKONFIRMASI` berasal dari PRD atau keputusan pengguna. `BELUM DIPUTUSKAN` memerlukan keputusan bisnis/arsitektur. Status fase tidak mengizinkan memulai fase berikutnya.
