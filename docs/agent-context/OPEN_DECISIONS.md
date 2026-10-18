# Open Decisions

Hal berikut belum disahkan oleh acuan yang diaudit dan harus dilaporkan sebelum implementasi terkait:

- Apakah istilah Project/Analysis pada persistence final memerlukan relasi storage selain kontrak schema v2 dan scope in-memory saat ini.
- Daftar lengkap field dan aturan validasi MappingVersion (terutama scope/unit/provenance) di luar field yang sudah didefinisikan kontrak; transformasi bisnis tidak boleh diasumsikan.
- Kebijakan freshness rinci per jenis input/mapping dan kapan status hasil berubah dari `STALE` ke `NEEDS_REVIEW`.
- Granularitas event bisnis tambahan di luar Save/Restore dan perubahan penting yang sudah diringkas repository.
- Kebijakan operasional per profil: komponen harga O/S, basis harga dasar/all-in, satuan, dan transformasi O→S serta Solar S→B.
- Tarif/basis pajak dan biaya di luar rumus template, komponen nol, margin negatif, serta expected values yang disahkan; EV-005 tetap TODO. Harga Jual dasar AHS adalah input tim dan harga setelah pajak hasil rumus (keputusan 2026-10-17).
- Skala dan metode pembulatan operasional. Engine saat ini mendukung EVERY_OPERATION; pilihan UI untuk preview bukan pengesahan kebijakan uang.
- Solver INU: satuan B, minimum/maksimum, step, pemilihan bila beberapa solusi memenuhi `50 ≤ Profit MUE < 51`, dan penanganan tanpa solusi.
- Syarat finalisasi bisnis sebelum `CONFIRMED`; penolakan `CONFIRMATION_UNAVAILABLE` tetap berlaku.

Fase 4 database/Auth sudah COMPLETE. Fase 5 UI dan uji pada stack lokal terisolasi telah diizinkan pengguna pada 2026-10-15. Pengguna memilih menetapkan kebijakan bisnis sekarang, tetapi belum memberikan nilai untuk keputusan di atas. Jangan menyimpulkan persetujuan dari instruksi “lanjutkan”.

Dokumen lama atau label workbook yang ambigu tidak menyelesaikan keputusan tersebut. Minta keputusan pengguna/owner sebelum mengubah kontrak bisnis.
