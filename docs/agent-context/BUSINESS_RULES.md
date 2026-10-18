# Business Rules

## Terkonfirmasi

- Keputusan pengguna 2026-10-18: kolom Harga INU/Solar Konversi menyalin Harga Dasar, PPN, PBBKB, PPH, OAT, PPN OAT, BPH, dan TOTAL/ALL IN dari revisi Evaluasi Vendor yang dipilih, tanpa menghitung ulang komponen sumber memakai tarif Konversi. Sel kosong pada revisi pilihan menghasilkan WAITING_INPUT. Kolom Biaya, solver INU, dan hubungan HPP AHS tetap mengikuti profil masing-masing. Pemilihan revisi tetap manual.

- Workspace/analysis memiliki batas yang jelas dalam Project; beberapa Analysis dalam satu Project harus dapat memiliki state dan histori independen.
- Pemilihan vendor dan offer revision dilakukan manual. Tidak ada auto-award atau compliance gate.
- Keputusan pengguna 2026-10-17: seluruh sel Evaluasi Vendor menerima input atau rumus langsung di workbook, termasuk Harga Dasar, nama vendor, PPH, label, metadata, total, dan catatan. Ini menggantikan larangan rumus pada PPH/Harga Dasar/nama vendor; default PPH tetap manual/kosong. Hasil perubahan kolom dicatat sebagai revisi baru tanpa mengganti revisi yang dipilih secara otomatis.
- O (selected offer), S (supplier base), dan B (conversion cost base) tetap berbeda. Keputusan pengguna 2026-10-16: HPP Harga Dasar AHS mengikuti B (`D30` INU / `D29` Solar); Harga Jual AHS diisi manual. Ini menggantikan aturan HPP manual pada PRD/spesifikasi lama untuk implementasi terbaru.
- Keputusan pengguna 2026-10-17: tim mengisi `Harga Jual · Harga Dasar` AHS (`I11` INU / `I10` Solar). PPN jual dan Harga Jual Setelah Pajak dihitung dari input tersebut memakai rumus template; `Harga Include` mengikuti jumlah komponen harga jual.
- Profil INU dan Solar Bawah independen. Profit MUE hanya operasional untuk INU; Solar Bawah tidak otomatis mewarisi state INU.
- Snapshot historis immutable. Restore membuat revisi baru. Revisi stale ditolak tanpa overwrite atau merge otomatis.
- Perubahan tersimpan harus dapat ditelusuri sebagai change event dengan aktor, waktu, target, aksi, before/after, dan alasan bila relevan.
- Mapping version menyimpan identitas, versi, source/target, scope, unit, status, dan provenance yang didefinisikan kontrak; aturan transformasi bisnis yang belum disahkan tidak boleh diarang.
- Perubahan input, selected offer revision, profil, atau mapping yang relevan dapat membuat konteks/hasil menjadi `STALE` atau `NEEDS_REVIEW`; hasil historis tetap dipertahankan.

## Batasan eksplisit

Formula engine, dependency graph operasional, solver, database/Supabase, autentikasi, dan UI interaktif bukan bagian Fase 2. EV-005 tetap TODO dan expected value/formula tidak boleh diubah.

## Bukti implementasi saat audit

Kontrak dan validasi ada di `apps/web/src/domain/contracts.ts` dan `validation.ts`; command/freshness ada di `commands.ts` dan `freshness.ts`; event/history ada di `change-events.ts` dan `persistence/in-memory-revision-repository.ts`. Tes Fase 2 berada di `apps/web/src/domain/__tests__/`.
