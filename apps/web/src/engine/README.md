# Formula engine aktif

`FormulaEngine(configuration).evaluate(snapshot)` menghitung kondisi aktif di memori. `recalculate(snapshot, previous)` memakai perubahan signature graph dan descendant terkait; previous harus berasal dari engine proses yang sama. Tidak ada publish, revision, replay, getRun, runHistory, database run, atau latest-run pointer.

`EngineRun` adalah preview transient berisi hasil, diagnostics, provisional assumptions, solver, konfigurasi, dan kondisi yang dipakai untuk incremental recalculation. WeakSet hanya memverifikasi identitas run dan tidak menahan arsip. `snapshotId` menandai draft yang dievaluasi, bukan referensi tabel snapshot. Hanya current preview yang diperlukan UI; Save menyimpan input/formula/mapping/configuration, lalu hasil dihitung lagi setelah load.

Offer dipilih manual memakai `offerId`, independen untuk INU/Solar Bawah. Nilai manual vendor canonical disimpan dalam offer; adapter storage mematerialisasikannya untuk graph cell aktif. Formula vendor tetap graph dependency aktif, termasuk teks nama vendor dan PPH kustom. Konversi menggunakan mapping `vendor-live:<offerId>:<cellId>`; tidak ada nilai revision yang dikunci.

## Kontrak kalkulasi

- Decimal BigInt dengan policy operasional 18 desimal, HALF_UP, EVERY_OPERATION.
- Parser menerima desimal, teks, `+ - * /`, unary sign, `%`, `SUM`, `@{cellId}`, dan `#{aggregateId}`. Adapter alamat sel menerjemahkan formula bar ke stable ID.
- Graph memvalidasi satu writer, reference, unit, scope, siklus/SCC dan dependensi. Error tidak diubah menjadi nol.
- Formula/mapping memakai stable `id` dan definisi aktif; signature memuat isi definisi, sehingga edit tetap menginvalidasi dependent tanpa formula/mapping version history.
- Policy/configuration/aggregate tokens tetap metadata cache aktif, bukan daftar versi tersimpan.
- Solver INU memakai kisi Biaya `0,01` dan menerima hanya `50 ≤ Profit MUE < 51`; Solar Bawah tidak menjalankan solver.
- HPP Harga Dasar AHS mengikuti Biaya Konversi profilnya. Harga Jual dasar AHS manual, hasil setelah pajak dihitung formula.
- Hasil tetap NONFINAL/ERROR; refactor persistence tidak mengesahkan finalisasi bisnis atau EV-005.

Batas parser: 16.384 karakter, 2.048 token, nesting 128, graph 10.000 node, koefisien decimal 256 karakter. Perbandingan manual seluruh angka Excel tetap di luar bukti tes persistence.
