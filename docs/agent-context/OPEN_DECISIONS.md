# Open Decisions

Keputusan storage final 2026-10-19 sudah ditetapkan: tiga tabel aktif projects/analyses/current_workbooks, satu payload normalized per Analysis, offer aktif berisi nilai, hasil kalkulasi transient, tanpa histori. Penghapusan fisik arsip lama diizinkan melalui migration `20261019071911_current_only_procurement.sql`, yang baru dibuat dan diverifikasi lokal; cloud belum diubah. Migration sebelumnya `20261019035326_current_workbooks_with_latest_data` tetap merupakan baseline cloud. Tidak tersedia restore ke kondisi sebelum Save terakhir.

Hal berikut belum disahkan oleh acuan yang diaudit dan harus dilaporkan sebelum implementasi terkait:

- Relasi storage Project/Analysis sudah ditetapkan: satu Project mempunyai banyak Analysis, setiap Analysis mempunyai satu current_workbooks dengan foreign key komposit project/owner.
- Daftar lengkap field dan aturan validasi MappingVersion (terutama scope/unit/provenance) di luar field yang sudah didefinisikan kontrak; transformasi bisnis tidak boleh diasumsikan.
- Kebijakan freshness rinci per jenis input/mapping dan kapan status hasil berubah dari `STALE` ke `NEEDS_REVIEW`.
- Granularitas event bisnis tambahan di luar Save/Restore dan perubahan penting yang sudah diringkas repository.
- Kebijakan operasional per profil: komponen harga O/S, basis harga dasar/all-in, satuan, dan transformasi O→S serta Solar S→B.
- Tarif/basis pajak dan biaya di luar rumus template, komponen nol, margin negatif, serta expected values yang disahkan; EV-005 tetap TODO. Harga Jual dasar AHS adalah input tim dan harga setelah pajak hasil rumus (keputusan 2026-10-17).
- Kesetaraan seluruh perhitungan AHS dengan workbook Excel pembanding belum diverifikasi. Keputusan 2026-10-19 telah menetapkan Biaya INU dua desimal, hasil antara 18 desimal HALF_UP EVERY_OPERATION, serta pembulatan tampilan dua desimal setelah PPN dikalikan volume; pembulatan bisnis tambahan tidak boleh disimpulkan dari angka tampilan Excel.
- Solver INU: minimum/maksimum bisnis dan tindak lanjut bisnis ketika tidak ada solusi. Keputusan 2026-10-19 telah menetapkan Biaya dalam IDR/L dua desimal, langkah otomatis `0,01`, parameter eksplisit kelipatan `0,01`, target internal `50 ≤ Profit MUE < 51`, serta pemilihan Profit terdekat dari atas 50 kemudian Biaya terendah.
- Syarat finalisasi bisnis sebelum `CONFIRMED`; penolakan `CONFIRMATION_UNAVAILABLE` tetap berlaku.

Fase 4 database/Auth sudah COMPLETE. Fase 5 UI dan uji pada stack lokal terisolasi telah diizinkan pengguna pada 2026-10-15. Pengguna memilih menetapkan kebijakan bisnis sekarang, tetapi belum memberikan nilai untuk keputusan di atas. Jangan menyimpulkan persetujuan dari instruksi “lanjutkan”.

Dokumen lama atau label workbook yang ambigu tidak menyelesaikan keputusan tersebut. Minta keputusan pengguna/owner sebelum mengubah kontrak bisnis.
