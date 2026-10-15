# Baseline Formula Audit v0.3

**Tanggal:** 14 Oktober 2026  
**Status:** Struktur formula dan subset aritmetika terverifikasi; validasi bisnis dan acceptance test aplikasi belum selesai.

## 1. Keputusan baseline

Baseline yang dipakai: `AHAS Sistem(4).xlsx`  
SHA-256: `efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc`

Identitas byte cocok dengan baseline terbaru yang disebut pada laporan v0.2. Nama file saja tidak digunakan untuk memilih baseline. Workbook sumber tidak diubah.

## 2. Metode yang dijalankan

1. Membaca OpenXML worksheet dan formula nodes langsung dari workbook.
2. Merekonstruksi shared formula anchors dan menerjemahkan formula relatif ke setiap shared follower.
3. Membuat inventaris per formula cell dan dependency langsung. Rentang seperti `SUM(C30:C35)` diekspansi menjadi alamat sel yang benar-benar dibaca.
4. Menjalankan evaluator aritmetika independen yang mendukung operator `+ - * /`, unary sign, persentase, referensi sel, rentang, dan `SUM`—yaitu subset yang ditemukan pada 166 formula di baseline ini.
5. Membandingkan hasil evaluator dengan cached values yang tersimpan, dengan toleransi numerik `max(1e-5, 1e-8 × magnitude)`. Perbandingan cache bersifat diagnostik; cached value bukan bukti recalculation Excel.
6. Menjalankan tes sensitivitas dengan override input secara in-memory. Tidak ada nilai yang ditulis kembali ke workbook sumber.

## 3. Rekonsiliasi hitungan

| Ukuran | AHAS INU | AHAS Solar bawah | Total |
|---|---:|---:|---:|
| Sel dengan elemen XML `<f>` | 86 | 80 | 166 |
| Formula yang menyimpan teks formula di XML | 44 | 38 | 82 |
| Shared formula followers tanpa teks lokal | 42 | 42 | 84 |
| Formula dievaluasi evaluator independen | 86 | 80 | 166 |
| Error evaluasi/parser | 0 | 0 | 0 |
| Kecocokan numerik dengan cache dalam toleransi | 82 | 76 | 158 |
| Kecocokan hasil teks dengan cache | 3 | 3 | 6 |
| Cached value kosong | 1 | 1 | 2 |
| Dependency edge langsung unik per formula-cell setelah ekspansi shared/range | — | — | 358 |

**Definisi dependency edge:** satu hubungan unik `formula cell → dependency cell`. Formula yang membaca alamat sama lebih dari sekali dalam satu formula dihitung satu kali untuk daftar edge unik. Rentang diekspansi per alamat. Angka 226 pada laporan terdahulu menggunakan metode/cakupan yang berbeda dan tidak boleh dibandingkan tanpa normalisasi definisi. Nilai 358 adalah hitungan menurut definisi eksplisit di atas.

## 4. Hasil perbandingan cache

- **158 sel numerik:** hasil evaluator cocok dengan cache dalam toleransi yang ditetapkan.
- **6 sel teks:** hasil evaluator cocok dengan cache.
- **2 sel cache kosong:** `AHAS INU!K6` merujuk `C18` yang kosong; `AHAS Solar bawah!K5` merujuk `C17` yang kosong. Evaluator mengembalikan `0` berdasarkan kebijakan evaluator untuk sel kosong, tetapi semantik yang harus dipakai aplikasi (0, empty, atau empty string) masih perlu diputuskan.
- **0 error evaluasi:** semua formula dapat dievaluasi oleh subset evaluator yang dibuat untuk sintaks yang ditemukan.

Ini membuktikan bahwa rumus yang ditemukan dapat diparse dan dihitung oleh evaluator yang dibuat dan sebagian besar hasilnya sesuai cache. Ini belum membuktikan kesesuaian dengan engine Excel pada semua kondisi, serta belum menyatakan bahwa asumsi bisnis pada formula benar.

## 5. Tes sensitivitas Profit MUE INU

Fixture sumber dipertahankan untuk komponen selain `D30`: `C30=20000`, `C32=1500`, `C33=60`, `C34=200`. Formula chain:

- `C38 = D30 - C30 - C32 - C33 - C34`
- `C39 = D30 * 0.25%`
- `C40 = C38 - C39`
- `C41 = C40 * 22%`
- `C42 = C40 - C41`

Hasil evaluator dengan perubahan input `D30` secara in-memory:

| D30 | C38 | C39 | C40 | C41 | C42 Profit MUE | Rentang target |
|---:|---:|---:|---:|---:|---:|---|
| 21878 | 118.00000 | 54.69500 | 63.30500 | 13.92710 | 49.37790 | Di bawah target |
| 21879 | 119.00000 | 54.69750 | 64.30250 | 14.14655 | 50.15595 | Diterima |
| 21880 | 120.00000 | 54.70000 | 65.30000 | 14.36600 | 50.93400 | Diterima |
| 21881 | 121.00000 | 54.70250 | 66.29750 | 14.58545 | 51.71205 | Di atas / sama dengan batas atas |

Kriteria target: `50.00 ≤ Profit MUE < 51.00`. Hanya berlaku untuk INU. Tes ini memverifikasi chain aritmetika dalam evaluator terhadap fixture yang disepakati; nilai tersebut bukan default proyek dan bukan rekomendasi otomatis untuk memilih harga.

## 6. Tes perubahan input lain

Mengubah `AHAS INU!D10` dari 20.000 menjadi 20.100 di fixture in-memory mengubah:

| Sel | Nilai baseline | Setelah D10 +100 |
|---|---:|---:|
| C30 | 20.000 | 20.100 |
| C32 | 1.500 | 1.507,5 |
| C33 | 60 | 60,3 |
| C38 | 120 | 12,2 |
| C39 | 54,7 | 54,7 |
| C40 | 65,3 | -42,5 |
| C41 | 14,366 | -9,35 |
| C42 | 50,934 | -33,15 |

Hasil yang negatif tetap hasil matematis untuk skenario buatan ini, bukan pernyataan bahwa penawaran tersebut layak secara bisnis. Pengujian ini mengonfirmasi propagasi pada dependency chain tersebut.

## 7. Catatan presisi klasifikasi faktor nol

Klasifikasi telah diperbaiki menggunakan pola yang membedakan faktor literal `*0` dari persentase `*0.3%` atau `*0.25%`. Hasil final menemukan **6** formula dengan faktor literal nol: INU `I12`, `I17`, `I18`; Solar Bawah `I11`, `I16`, `I17`. Formula `D13`, `C33`, dan `C39` tidak lagi salah klasifikasi sebagai faktor nol.

## 8. Temuan dan keputusan terbuka

| ID | Temuan | Status | Tindakan |
|---|---|---|---|
| F-001 | Dua cached value kosong pada K6 (INU) dan K5 (Solar bawah) karena sumber sel kosong | Perlu konfirmasi PIC | Putuskan semantik empty vs zero pada formula engine. |
| F-002 | Enam formula memiliki faktor literal `*0`: INU I12, I17, I18; Solar Bawah I11, I16, I17 | Perlu konfirmasi PIC | Konfirmasi apakah enam faktor nol tersebut menandai komponen nonaktif atau aturan biaya yang disepakati; jangan menghapus tanpa keputusan. |
| F-003 | Dependency edge unik setelah ekspansi adalah 358; angka terdahulu 226 belum sebanding definisinya | Metode dinyatakan | Gunakan edge unik `formula cell → dependency cell` sebagai definisi katalog; pertahankan catatan metodologi. |
| F-004 | Evaluator aritmetika cocok dengan semua cached values yang tersedia, tapi bukan Excel recalculation | Belum selesai | Lanjutkan uji perubahan input, formula-error semantics, dan tes acceptance engine aplikasi. |
| F-005 | Baseline dipilih berdasarkan SHA-256 | Terkunci | Semua fixture/laporan berikutnya harus menyebut hash. |
| F-006 | HPP manual, penawaran manual, dan profil INU/Solar independen adalah aturan aplikasi, bukan sesuatu yang boleh disimpulkan dari link sumber | Terkunci | Tambahkan acceptance test aplikasi untuk setiap aturan. |
| F-007 | Profit MUE Solar bawah non-operasional | Terkunci | Pertahankan untuk audit sumber, jangan jadikan target solver. |

## 9. Artefak yang dihasilkan

- `BASELINE_FORMULA_AUDIT_v0.3.xlsx`: ringkasan, inventaris formula, peta dependensi, matriks pengujian, dan log temuan/keputusan.
- `AUDIT_FORMULA_BASELINE_v0.3.csv`: inventaris satu baris per formula cell dengan formula hasil ekspansi, cache, hasil evaluator, status, dan dependensi.
- `AUDIT_DEPENDENSI_FORMULA_v0.3.csv`: daftar hubungan langsung formula cell ke alamat sel dependensi.

## 10. Batas audit

Audit ini **belum selesai sebagai validasi sistem end-to-end**. Hal yang belum dilakukan:

1. Validasi semantik bisnis oleh PIC atas setiap formula dan input yang ambigu.
2. Uji formula engine produksi dengan perhitungan ulang berbasis dependency graph.
3. Uji circular dependency, error propagation, input invalid, dan rumus tak didukung pada aplikasi.
4. Uji alur aplikasi Evaluasi Vendor → pemilihan offer revision manual → Konversi Satuan Jagad → HPP AHS manual.
5. Uji histori revisi dan isolasi profil INU/Solar Bawah.

**Keputusan PM/Engineering berikutnya:** baseline formula dapat digunakan sebagai fixture awal untuk membangun test suite. Lanjutkan dengan membangun test harness otomatis dari CSV ini dan melengkapi acceptance test aturan aplikasi; jangan mulai dengan UI penuh.
