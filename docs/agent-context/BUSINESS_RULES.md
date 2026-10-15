# Business Rules

## Terkonfirmasi

- Workspace/analysis memiliki batas yang jelas dalam Project; beberapa Analysis dalam satu Project harus dapat memiliki state dan histori independen.
- Pemilihan vendor dan offer revision dilakukan manual. Tidak ada auto-award atau compliance gate.
- O (selected offer), S (supplier base), B (conversion cost base), dan H (HPP AHS manual) adalah entitas/nilai berbeda. H tidak boleh auto-bind ke B atau S.
- Profil INU dan Solar Bawah independen. Profit MUE hanya operasional untuk INU; Solar Bawah tidak otomatis mewarisi state INU.
- Snapshot historis immutable. Restore membuat revisi baru. Revisi stale ditolak tanpa overwrite atau merge otomatis.
- Perubahan tersimpan harus dapat ditelusuri sebagai change event dengan aktor, waktu, target, aksi, before/after, dan alasan bila relevan.
- Mapping version menyimpan identitas, versi, source/target, scope, unit, status, dan provenance yang didefinisikan kontrak; aturan transformasi bisnis yang belum disahkan tidak boleh diarang.
- Perubahan input, selected offer revision, profil, atau mapping yang relevan dapat membuat konteks/hasil menjadi `STALE` atau `NEEDS_REVIEW`; hasil historis tetap dipertahankan.

## Batasan eksplisit

Formula engine, dependency graph operasional, solver, database/Supabase, autentikasi, dan UI interaktif bukan bagian Fase 2. EV-005 tetap TODO dan expected value/formula tidak boleh diubah.

## Bukti implementasi saat audit

Kontrak dan validasi ada di `apps/web/src/domain/contracts.ts` dan `validation.ts`; command/freshness ada di `commands.ts` dan `freshness.ts`; event/history ada di `change-events.ts` dan `persistence/in-memory-revision-repository.ts`. Tes Fase 2 berada di `apps/web/src/domain/__tests__/`.
