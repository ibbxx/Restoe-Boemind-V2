# Audit rumus Evaluasi Vendor

Tanggal: 2026-10-17. Cakupan: kedua jalur `WorksheetSurface` (snapshot lama v2 dan template dinamis v3), input sel sampai draft/revisi penawaran. Ini laporan inspeksi kode dan pemeriksaan statis; pengujian interaksi aplikasi tetap manual oleh pengguna.

## Keputusan pengguna

Semua sel Evaluasi Vendor boleh menerima nilai atau rumus langsung di workbook. Ini mencakup nama vendor, Harga Dasar, PPH, label, metadata, total, catatan, dan sel kosong yang ditampilkan. Larangan rumus PPH/Harga Dasar/nama vendor sebelumnya digantikan oleh instruksi ini. PPH default tetap input kosong/manual. Pemilihan offer/revisi tetap manual.

## Penyebab yang ditemukan dan perubahan

| Temuan kode | Dampak | Perbaikan |
| --- | --- | --- |
| `manualVendorPph` dipanggil pada load/edit dan menghapus writer formula PPH. | Rumus pengguna hilang setelah diterapkan. | Fungsi dan semua pemanggilnya dihapus; template awal tetap tidak memasang rumus PPH. |
| `setCellFormula` menolak Harga Dasar, nama vendor, dan label template. | Beberapa sel menolak rumus sebelum dihitung. | Validasi membolehkan seluruh sel Evaluasi Vendor; perlindungan Konversi/AHS dan mapping target tetap berlaku. |
| Nama, catatan, label, dan sel harga memakai jalur render/input berbeda. Ada sel HTML tanpa cell ID. | Sebagian sel tidak bisa dipilih/diedit atau tidak tersambung ke engine. | Semua sel Evaluasi Vendor memakai `WorksheetCellInput`; sel legacy yang ditampilkan dimaterialisasi dengan ID stabil. |
| Input formula langsung dan input melalui formula bar mempunyai lifecycle fokus berbeda. | Draft bisa kehilangan fokus, terpotong, atau gagal memasukkan referensi. | Editor vendor mempertahankan draft selama mengetik; Enter/Tab/blur melakukan commit, Escape membatalkan. Penangkapan klik sumber mengecualikan input rumus yang sedang aktif. |
| Sel legacy disimpan dalam tabel terpisah, sementara referensi pendek dicari hanya di satu tabel. | `C10` tidak menemukan sel sumber dalam bagian EV yang sama. | Pencarian legacy memakai namespace EV; template dinamis tetap memakai tabel lokal. Kode ganda/hilang tetap ditolak. |
| Input pengguna belum menerjemahkan rentang, referensi absolut, pemisah `;`, atau fungsi `sum` huruf kecil. | Rumus spreadsheet yang lazim ditolak parser. | Adapter memperluas rentang menjadi ID stabil, menerima `$C$10`, `SUM`/`sum`, dan pemisah `,`/`;`. Ekspansi dibatasi. |
| Nama/catatan hanya dapat mengacu ke teks yang sudah ada; literal teks belum masuk grammar. | Formula teks seperti `="Vendor A"` tidak dapat dipakai. | Parser/evaluator menerima literal teks dan escape petik Excel. Transformasi alamat tidak menyentuh isi literal teks. |
| Pencatatan revisi vendor hanya berjalan untuk input manual tertentu. | Rumus terlihat berubah tetapi hasilnya tidak tersedia dalam revisi penawaran baru. | `recordVendorRevisions` menghitung dependency closure EV melalui graph/evaluator yang sama, menyimpan hasil serta ekspresi rumus, dan membuat revisi baru jika isi berubah. |
| Penyiapan kolom vendor dapat menimpa formula/input kolom yang belum terdaftar. | Isi yang diketik sebelum nama vendor dapat hilang. | Kolom disiapkan sebelum render dan penyiapan mempertahankan formula/input yang sudah ada. |
| Error dari perubahan snapshot dapat ditangkap parent tanpa diteruskan ke editor. | Editor menganggap penerapan berhasil walau draft tidak berubah. | Perubahan worksheet diteruskan langsung ke `edit`; boundary editor menerima kegagalan dan menampilkan error. |

## Inventaris sel pada tampilan legacy

Untuk tiga vendor tanpa baris tambahan, terdapat 49 sel logis yang ditampilkan. Sel hasil merge diedit melalui anchor-nya.

| Bagian | Alamat | Jalur editor |
| --- | --- | --- |
| Judul | B3 | Editor nilai/rumus bersama |
| Baris kosong | B4, B8 | Editor nilai/rumus bersama |
| Label dan isi metadata | B5:B7, D5:D7 | Editor nilai/rumus bersama |
| Uraian dan nama vendor | B9:E9 | Editor nilai/rumus bersama |
| Label dan komponen harga/pajak | B10:E16 | Editor nilai/rumus bersama |
| Total | B17:E17 | Editor nilai/rumus bersama |
| Catatan | B18:E18 | Editor nilai/rumus bersama |
| Vendor/baris tambahan | Alamat kolom/baris berikutnya | ID serta editor yang sama; tidak memakai `<td>` kosong sebagai pengganti sel data |

Pada template dinamis, setiap cell snapshot yang dirender dalam bagian Evaluasi Vendor melewati editor bersama, termasuk presentation `LABEL`, `INPUT`, `RESULT`, dan `BLANK`. Area tertutup merge tetap diwakili anchor.

## Alur perhitungan dan revisi

1. Klik sel memuat nilai mentah atau rumus yang sudah diterjemahkan ke alamat sel.
2. Ketikan memperbarui draft editor; engine tidak dijalankan per karakter.
3. Klik sumber saat draft diawali `=` memasukkan referensi pada posisi kursor.
4. Commit menerjemahkan alamat/rentang menjadi stable ID. Domain memeriksa keberadaan, scope, writer, serta siklus.
5. Normalisasi draft menyiapkan sel yang belum ada tanpa menghapus formula pengguna.
6. Pencatatan revisi memakai evaluator decimal di luar UI. Asumsi input numerik kosong mengikuti preview yang sudah berlaku; input manual kosong tetap tersimpan `UNSET`, referensi rusak tetap error. Ekspresi formula disertakan sebagai provenance pada nilai revisi.
7. Revisi baru tidak mengganti selected revision. Mapping Konversi dinamis tetap membaca nilai immutable revisi yang dipilih; legacy juga menyalin nilai dari revisi pilihan melalui mapping eksplisit.
8. Save memakai snapshot ref terbaru setelah commit; load mempertahankan formula yang tersimpan. Snapshot historis tidak dimutasi.

## Contoh sintaks yang didukung

- `=C10*11%`
- `=EV!C10*0.3%`
- `=SUM(C10:C16)` atau `=sum($C$10:$C$16)`
- `=SUM(C10;C11;C12)`
- `="Vendor A"` dan `=D9` pada sel teks

Grammar juga mendukung angka, tanda positif/negatif, `+`, `-`, `*`, `/`, `%`, tanda kurung, dan `SUM`. Ini bukan seluruh grammar Excel: fungsi lain dan operator di luar daftar tersebut belum diimplementasikan. Siklus, sumber tidak ada, pembagian nol, dan scope profil yang tidak sah tetap ditolak/ditandai error. Angka nol tetap kosong pada tampilan sesuai instruksi sebelumnya.

## Verifikasi dan batas bukti

- Inspeksi jalur renderer legacy/dinamis, adapter alamat, domain writer, parser/evaluator, normalisasi load/edit, revisi penawaran, dan Save.
- `npm run check` menjalankan lint dan pemeriksaan tipe saja. Tidak ada script test/fixture/browser otomatis yang dibuat atau dijalankan.
- `git diff --check` untuk whitespace dan konflik patch.
- Belum ada bukti eksekusi interaksi browser, Save/load melalui akun pengguna, atau penerapan ke cloud dalam pekerjaan ini. Pemeriksaan statis tidak menggantikan penerimaan manual aplikasi.

File utama: `src/ui/worksheet-cell-input.tsx`, `src/ui/worksheet-surface.tsx`, `src/ui/procurement-workspace.tsx`, `src/domain/cell-address.ts`, `src/domain/legacy-sheet.ts`, `src/domain/dynamic-workflow.ts`, `src/domain/structure.ts`, `src/domain/vendor-revisions.ts`, `src/engine/parser.ts`, dan `src/engine/evaluator.ts` di `apps/web/`.
