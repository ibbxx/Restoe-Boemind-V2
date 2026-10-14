# Analisis Mendalam AHAS Sistem — Versi Terbaru

**File sumber:** `AHAS Sistem(4).xlsx`  
**SHA-256:** `efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc`  
**Cakupan:** `AHAS INU` dan `AHAS Solar bawah`, rentang aktif A1:L42 dan A1:L41.  
**Metode:** formula, nilai tersimpan/cached result, label sel, referensi langsung dan range reference diperiksa menggunakan artifact_tool. Workbook sumber tidak diubah. Perhitungan utama diverifikasi secara aritmetika menggunakan nilai yang tersimpan, bukan dengan menjalankan recalculation Excel.

## 1. Ringkasan eksekutif

1. Versi terbaru menghapus formula di `AHAS Solar bawah!C38` dan menggantinya dengan nilai input `0`. Karena itu, nilai tersimpan `C39:C41` sekarang menjadi `0`; formula di `C39:C41` masih ada. Ini sejalan dengan arahan pengguna bahwa blok Gross Profit/BPH Migas/Net Margin/PPH/Profit MUE **tidak dipakai untuk operasional Solar Bawah**.
2. Pada `AHAS INU`, blok `C38:C42` berisi rumus Gross Profit, BPH Migas, Net Margin, PPH, dan Profit MUE. Berdasarkan konteks yang disampaikan pengguna, blok ini relevan untuk alur INU/Dinar dan harus diperlakukan terpisah dari kalkulasi Solar Bawah.
3. Ada mapping yang perlu diverifikasi: label Sumber di AHS mengambil nama vendor pertama (`C9`/`C8`), sementara nama INU pada area Konversi mengambil kolom D (`D9`/`D8`). Untuk Solar Bawah, harga konversi `C29=18.000` tidak terhubung ke harga penawaran Katana `D9=18.500`. Bisa saja angka 18.000 adalah harga yang sengaja dinegosiasikan, tetapi hubungan itu tidak tercatat sebagai formula.
4. Tanggal analisis tampil berformat `dd/mm/yyyy` dengan serial `46225`, yang berarti **22/07/2026**, sedangkan periode pada kedua worksheet berbunyi **15–31 Oktober 2026**. Perlu dikonfirmasi apakah tanggal analisis atau periode yang tidak mutakhir.
5. Di tiap AHS, kuantitas pada kolom J sebagian diisi langsung `50.000` untuk masing-masing baris biaya. Mengubah `J11`/`J10` tidak otomatis mengubah semua kuantitas yang berupa angka tetap. Aplikasi sebaiknya memisahkan satu kuantitas proyek utama dari kuantitas override per komponen.

### Perubahan dari versi sebelumnya

| Worksheet | Sel | Versi sebelumnya | Versi terbaru |
| --- | --- | --- | --- |
| AHAS Solar bawah | C38 | `=D29*0.25%` menghasilkan 45 | Nilai input 0; formula dihapus |
| AHAS Solar bawah | C39 | `=C37-C38` menghasilkan -45 | Formula tetap; nilai tersimpan 0 |
| AHAS Solar bawah | C40 | `=C39*22%` menghasilkan -9,9 | Formula tetap; nilai tersimpan 0 |
| AHAS Solar bawah | C41 | `=C39-C40` menghasilkan -35,1 | Formula tetap; nilai tersimpan 0 |

Menurut perbandingan nilai dan formula dalam rentang yang sama, empat alamat sel tersebut adalah seluruh perbedaan yang terdeteksi antara file versi sebelumnya dan file terbaru.

## 2. Gambaran struktur workbook

| Area | AHAS INU | AHAS Solar bawah |
|---|---|---|
| Evaluasi harga vendor | B9:E17; kandidat PT Jagad, AKR, PT Petrocon | B8:E16; kandidat Aman 88, Katana, Jangkar |
| Konversi Satuan INU | B23:D36; nama INU AKR, basis Harga INU dan Biaya | B22:D35; nama INU Katana, basis Harga INU dan Biaya |
| Ringkasan MUE | B38:C42 | B37:C41, tetapi tidak dipakai operasional menurut keterangan pengguna |
| Analisis Harga Satuan | G3:L38 | G2:L37 |

Struktur menggabungkan tiga area pada worksheet yang sama: evaluasi penawaran vendor, konversi, dan AHS. Implementasi web tidak harus meniru alamat sel Excel secara literal, tetapi harus mempertahankan makna field dan ketergantungan yang disetujui.

## 3. Pemetaan sel penting dan risiko logika

### A. Evaluasi vendor dan harga penawaran

- **AHAS INU:** `C10=19.900` untuk PT Jagad; `D10=20.000` untuk AKR. `C11=C10*11%` menghasilkan PPN 2.189. Pada AKR, `D12=D10*7,5%` menghasilkan 1.500 dan `D13=D10*0,3%` menghasilkan 60. Nilai D11 (PPN 2.200), D14 (OAT 200), dan D15 (PPN OAT 22) adalah input tetap dalam file. `D17=SUM(D10:D15)=23.982` menjadi total include AKR.
- **AHAS Solar bawah:** `C9=18.000` untuk Aman 88 dan `D9=18.500` untuk Katana. `C10=C9*11%=1.980`, sedangkan D10 (PPN Katana 2.035) adalah input tetap. Total include yang tersimpan adalah `C16=19.980` dan `D16=20.535`.
- `C17`, `D17`, `E17` (INU) dan `C16`, `D16`, `E16` (Solar Bawah) menjumlahkan baris rincian vendor. Angka-angka input ini adalah isi workbook saat ini, bukan otomatis baseline untuk proyek baru.

### B. Konversi Satuan INU dan posisi Dinar

- **INU:** `C27=D9` menampilkan AKR; `C30=D10` mengambil harga dasar AKR sebesar 20.000; `D30=21.880` adalah input manual di kolom Biaya. `C31=C30*11%`, `C32=C30*7,5%`, `C33=C30*0,3%`, `C35=C34*11%`, dan `C36=SUM(C30:C35)=23.982`. Nilai `D30` tidak dihasilkan dari formula harga vendor; ia merupakan basis biaya terpisah.
- Rumus `C38=D30-C30-C32-C33-C34` menghasilkan Gross Profit 120; `C39=D30*0,25%` menghasilkan 54,70; `C40=C38-C39` menghasilkan Net Margin 65,30; `C41=C40*22%` menghasilkan PPH 14,366; dan `C42=C40-C41` menghasilkan Profit MUE 50,934. Rumus ini merupakan cabang perhitungan MUE; jangan disamakan dengan laba bersih AHS di kolom L.
- **Risiko pilihan vendor:** `C27` hanya mengambil nama dari D9, dan `C30` mengambil harga dari D10. Itu cocok selama AKR berada di kolom D, tetapi bukan pemilihan vendor yang benar-benar dinamis berdasarkan ID/nama. Sistem web harus menghubungkan record penawaran terpilih kepada harga dengan ID penawaran yang sama, bukan mengandalkan posisi kolom.

### C. Konversi Satuan Solar Bawah — perlakuan khusus

- `C26=D8` menampilkan Katana. Namun `C29=18.000` adalah konstanta, lalu `D29=C29`. Harga Katana pada evaluasi vendor adalah `D9=18.500`; tidak ada formula yang menghubungkan D9 ke C29. Ini tidak membuktikan harga 18.000 salah—mungkin ada kesepakatan khusus—tetapi alasan atau sumber harga 18.000 belum tersimpan di workbook.
- `C30=C29*11%=1.980`; `C35=SUM(C29:C34)=19.980`; `D35=19.980` diisi sebagai nilai. AHS mengambil HPP dasar dari `I15=D29=18.000` dan PPN dari `I20=I15*11%=1.980`.
- Menurut arahan pengguna, baris `Gross Profit`, `BPH Migas`, `Net Margin`, `PPH`, `Profit MUE`, dan `Crosscheck` pada Solar Bawah tidak digunakan untuk hasil operasional. Walaupun `C37`, `C39:C41` masih mempunyai formula, aplikasi harus menandai seluruh blok sebagai **non-operasional / not applicable** pada profil Solar Bawah, bukan menampilkannya sebagai metrik laba yang sah. Nilai nol di file terbaru bukan bukti bahwa formula tersebut perlu dipakai.

### D. Analisis Harga Satuan (AHS)

**Rumus umum yang tampak pada kedua worksheet:**
- Harga include: `J8=SUM(I11:I13)` pada INU; `J7=SUM(I10:I12)` pada Solar Bawah.
- Harga jual setelah pajak: `L10=SUM(I11:I13)` (INU) dan `L9=SUM(I10:I12)` (Solar Bawah). Komponen harga dasar dihitung sebagai harga include / 1,11; PPN dihitung 11%; PBBKB dikalikan faktor `0`, sehingga tidak masuk pada harga jual contoh.
- Total pendapatan: `L9=L10*J11` (INU) dan `L8=L9*J10` (Solar Bawah). Dengan harga include 25.900 dan kuantitas 50.000, total pendapatan tersimpan 1.295.000.000.
- Total biaya merupakan penjumlahan subtotal biaya per komponen pada kolom K; biaya per liter merupakan penjumlahan nilai per unit pada kolom I. HPP dasar mengambil konversi: `I16=D30=21.880` untuk INU dan `I15=D29=18.000` untuk Solar Bawah. PPN pembelian dihitung di baris terpisah (`I21=I16*11%` untuk INU; `I20=I15*11%` untuk Solar Bawah).

**Nilai ringkasan AHS yang tersimpan pada file:**
| Metrik | AHAS INU | Solar Bawah |
| --- | --- | --- |
| Harga include | 25.900 | 25.900 |
| Kuantitas utama | 50.000 | 50.000 |
| Total pendapatan | 1.295.000.000 | 1.295.000.000 |
| Total biaya | 1.239.340.000 | 1.029.000.000 |
| Biaya per liter | 24.786,8 | 20.580 |
| Laba kotor (pendapatan - total biaya) | 55.660.000 | 266.000.000 |
| Selisih PPN | 7.993.333,33 | 29.333.333,33 |
| Laba bersih (laba kotor - selisih PPN) | 47.666.666,67 | 236.666.666,67 |
| Laba bersih per liter | 953,33 | 4.733,33 |
| Persentase | 3,8461% | 22,9997% |

Catatan: `L38=L36/L14` pada INU dan `L37=L35/L13` pada Solar Bawah membagi laba bersih dengan total biaya, bukan dengan total pendapatan. Nama `PERSENTASE` belum menjelaskan definisinya; jangan mengubah penyebutnya tanpa keputusan PIC.

### E. Field AHS yang tidak mengikuti konteks konversi

- `AHAS INU!K4=C9` membuat Sumber AHS menjadi **PT Jagad**, sedangkan Konversi menampilkan AKR di `C27`. `AHAS Solar bawah!K3=C8` membuat Sumber AHS menjadi **Aman 88**, sedangkan Konversi menampilkan Katana di `C26`. Ini bisa berarti Sumber memang berarti sesuatu yang lain, tetapi jika Sumber dimaksudkan sebagai vendor terpilih, mapping saat ini tidak konsisten.
- `AHAS INU!K6=C18` dan `AHAS Solar bawah!K5=C17` mengarah ke sel kosong. Karena labelnya `Dokumen`, field dokumen tidak mengambil referensi yang berisi pada file ini.
- Tanggal analisis pada `H4` dan `H3` bernilai serial 46225 dengan format tanggal, yakni 22 Juli 2026, sementara area Konversi menyebut periode 15–31 Oktober 2026.

## 4. Keputusan yang perlu masuk ke PRD

1. **Vendor terpilih harus berupa record, bukan teks/posisi kolom.** Menyimpan `selectedOfferId` agar nama dan harga di Konversi serta AHS berasal dari penawaran yang sama.
2. **Bedakan harga sumber dan basis Biaya.** Untuk profil INU, harga sumber (`C30`) dan basis Biaya (`D30`) berbeda. Jangan paksa `D30=C30` atau hitung `D30` dari sebuah delta tanpa persetujuan PIC.
3. **Profil INU dan Solar Bawah harus punya konfigurasi formula terpisah.** Blok Profit MUE hanya aktif pada profil INU/Dinar menurut aturan yang diberikan; untuk Solar Bawah blok tersebut non-operasional.
4. **Semua angka contoh harus punya status input/contoh.** Vendor, pelanggan, lokasi, harga jual 25.900, kuantitas 50.000, biaya marketing, proyek, mediator/keagenan, dan tanggal tidak boleh otomatis menjadi nilai default produksi tanpa konfirmasi.
5. **Kuantitas AHS perlu sumber utama tunggal.** Setiap baris biaya mengikuti quantity proyek utama secara default, dengan override hanya jika dimaksudkan dan ditandai.
6. **Formula yang dikalikan 0 bukan aturan aktif.** Misalnya `I12=I11*7,5%*0`, `I17=I15*7,5%*0`, `I11=I10*7,5%*0`, `I16=I14*7,5%*0`. Simpan status komponen (aktif/nonaktif) sebagai konfigurasi eksplisit, bukan mengandalkan magic zero.
7. **Definisikan arti Persentase dan Selisih PPN.** Formula saat ini dapat dihitung, tetapi interpretasi bisnisnya perlu terdokumentasi.
8. **Rapikan mapping field Sumber dan Dokumen.** Sumber harus mengikuti definisi bisnis yang disetujui; Dokumen tidak boleh menunjuk ke sel kosong.
9. **Pertahankan audit trail.** Jika harga Katana berubah, sistem mencatat nilai penawaran, harga yang dipilih untuk konversi (termasuk jika berbeda sebagai harga khusus), alasan perubahan, dan dampak ke AHS.

## 5. Validasi formula dan nilai

- Sel berisi nilai atau formula: 410 total (205 per worksheet).
- Formula-bearing cells pada area yang diperiksa: 44 di AHAS INU dan 38 di Solar bawah, total 82.
- Referensi sel setelah rentang diekspansi: 226 kemunculan referensi (INU 116; Solar Bawah 110).
- Perbandingan formula dan nilai dengan workbook versi sebelumnya tidak menunjukkan perubahan selain C38:C41 pada Solar Bawah.
- Hasil laba, biaya, dan pendapatan di atas konsisten secara aritmetika dengan nilai formula/cache yang tersimpan di workbook. Saya tidak menjalankan recalculation Excel; karena itu nilai tersimpan tidak diperlakukan sebagai bukti bahwa semua formula otomatis terhitung ulang dengan Excel.
- Jika dokumen reverse-engineering sebelumnya menyebut 167 formula, samakan dulu definisi hitungnya: audit ini menghitung sel yang benar-benar berisi formula di rentang worksheet dan mencatat 82 sel formula. Angka 167 tidak boleh dibandingkan langsung tanpa metode hitung yang sama.

## Lampiran A — daftar setiap sel formula

### AHAS INU
| Sel | Label terdekat | Formula | Hasil tersimpan | Referensi | Catatan |
| --- | --- | --- | --- | --- | --- |
| K4 | Sumber | `=C9` | PT Jagad | C9 | AHS Sumber mengambil C9 (PT Jagad), sedangkan nama INU di konversi C27 adalah AKR. Perlu konfirmasi/mapping. |
| K5 | Lokasi | `=C26` | Samarinda | C26 | — |
| K6 | Dokumen | `=C18` | kosong | C18 | Dokumen mengambil C18 yang kosong; kemungkinan referensi salah atau field belum diisi. |
| J8 | HARGA INCLUDE | `=sum(I11:I13)` | 25900 | I11:I13 | — |
| L9 | TOTAL PENDAPATAN | `=L10*J11` | 1295000000 | L10, J11 | — |
| C10 | Harga Dasar | `=19900` | 19900 | — | — |
| L10 | HARGA JUAL SETELAH PAJAK | `=SUM(I11:I13)` | 25900 | I11:I13 | — |
| C11 | PPN | `=C10*11%` | 2189 | C10 | — |
| I11 | Harga Dasar | `=25900/1.11` | 23,333.33333 | — | — |
| K11 | Harga Dasar | `=I11*J11` | 1166666667 | I11, J11 | — |
| D12 | PBBKB | `=D10*7.5%` | 1500 | D10 | — |
| I12 | PBBKB | `=I11*7.5%*0` | 0 | I11 | PBBKB pada harga jual dihitung dengan pengali 0, sehingga dinonaktifkan pada contoh ini. |
| J12 | PBBKB | `=J11` | 50000 | J11 | — |
| D13 | PPH | `=D10*0.3%` | 60 | D10 | Formula sengaja/tampak dinonaktifkan oleh faktor 0; jangan menganggap komponen ini aktif tanpa keputusan PIC. |
| I13 | PPN 11% | `=I11*11%` | 2,566.666667 | I11 | — |
| L14 | TOTAL BIAYA | `=sum(K16:K33)` | 1239340000 | K16:K33 | — |
| C15 | PPN OAT | `=C14*11%` | 0 | C14 | — |
| L15 | BIAYA PERLITER | `=sum(I16:I33)` | 24,786.8 | I16:I33 | — |
| I16 | Harga Dasar | `=D30` | 21880 | D30 | — |
| J16 | Harga Dasar | `=J11` | 50000 | J11 | — |
| K16 | Harga Dasar | `=I16*J16` | 1094000000 | I16, J16 | — |
| C17 | OAT | `=sum(C10:C16)` | 22089 | C10:C16 | — |
| D17 | OAT | `=sum(D10:D15)` | 23982 | D10:D15 | — |
| E17 | OAT | `=SUM(E10:E16)` | 0 | E10:E16 | — |
| I17 | OAT | `=I15*7.5%*0` | 0 | I15 | Formula memakai referensi I15 yang kosong dan pengali 0; bukan perhitungan OAT aktif yang dapat diandalkan. |
| J17 | OAT | `=J16` | 50000 | J16 | — |
| I21 | PPN 11% | `=I16*11%` | 2,406.8 | I16 | — |
| C27 | Nama INU     : | `=D9` | AKR | D9 | Nama INU konversi = D9 (AKR), sehingga pilihan saat ini terkunci pada kolom D, bukan lookup dinamis berdasarkan nama. |
| C30 | Harga Dasar | `=D10` | 20000 | D10 | Harga INU = D10. Benar untuk AKR pada posisi kolom D, tetapi tidak mengikuti pilihan vendor dinamis bila vendor dipindah/diganti. |
| C31 | PPN | `=C30*11%` | 2200 | C30 | — |
| C32 | PBBKB | `=C30*7.5%` | 1500 | C30 | — |
| C33 | PPH | `=C30*0.3%` | 60 | C30 | Formula sengaja/tampak dinonaktifkan oleh faktor 0; jangan menganggap komponen ini aktif tanpa keputusan PIC. |
| L34 | LABA KOTOR | `=L9-L14` | 55660000 | L9, L14 | — |
| C35 | PPN | `=C34*11%` | 22 | C34 | — |
| L35 | SELISIH PPN | `=K13-K21` | 7,993,333.333 | K13, K21 | — |
| C36 | ALL IN | `=SUM(C30:C35)` | 23982 | C30:C35 | — |
| L36 | LABA BERSIH | `=L34-L35` | 47,666,666.67 | L34, L35 | — |
| L37 | LABA BERSIH PERLITER | `=L36/J11` | 953.3333333 | L36, J11 | — |
| C38 | Gross Profit | `=D30-C30-C32-C33-C34` | 120 | D30, C30, C32, C33, C34 | Rumus Gross Profit = D30-C30-C32-C33-C34. Jangan disamakan dengan laba AHS; ini cabang perhitungan MUE. |
| L38 | PERSENTASE | `=L36/L14` | 0.03846133157 | L36, L14 | Persentase = laba bersih / total biaya (bukan laba bersih / pendapatan). Definisi KPI harus dipastikan. |
| C39 | BPH Migas | `=D30*0.25%` | 54.7 | D30 | Formula sengaja/tampak dinonaktifkan oleh faktor 0; jangan menganggap komponen ini aktif tanpa keputusan PIC. |
| C40 | Net Margin | `=C38-C39` | 65.3 | C38, C39 | — |
| C41 | PPH | `=C40*22%` | 14.366 | C40 | — |
| C42 | Profit MUE | `=C40-C41` | 50.934 | C40, C41 | Profit MUE = Net Margin - PPh. Relevan untuk alur INU/Dinar menurut konteks bisnis yang disampaikan user. |

### AHAS Solar bawah
| Sel | Label terdekat | Formula | Hasil tersimpan | Referensi | Catatan |
| --- | --- | --- | --- | --- | --- |
| K3 | Sumber | `=C8` | Aman 88 | C8 | AHS Sumber mengambil C8 (Aman 88), sedangkan nama INU di konversi C26 adalah Katana. Perlu konfirmasi/mapping. |
| K4 | Lokasi | `=C25` | Samarinda | C25 | — |
| K5 | Dokumen | `=C17` | kosong | C17 | Dokumen mengambil C17 yang kosong; kemungkinan referensi salah atau field belum diisi. |
| J7 | HARGA INCLUDE | `=sum(I10:I12)` | 25900 | I10:I12 | — |
| L8 | TOTAL PENDAPATAN | `=L9*J10` | 1295000000 | L9, J10 | — |
| L9 | HARGA JUAL SETELAH PAJAK | `=SUM(I10:I12)` | 25900 | I10:I12 | — |
| C10 | PPN | `=C9*11%` | 1980 | C9 | — |
| I10 | Harga Dasar | `=25900/1.11` | 23,333.33333 | — | — |
| K10 | Harga Dasar | `=I10*J10` | 1166666667 | I10, J10 | — |
| I11 | PBBKB | `=I10*7.5%*0` | 0 | I10 | PBBKB pada harga jual dihitung dengan pengali 0, sehingga dinonaktifkan pada contoh ini. |
| J11 | PBBKB | `=J10` | 50000 | J10 | — |
| I12 | PPN 11% | `=I10*11%` | 2,566.666667 | I10 | — |
| L13 | TOTAL BIAYA | `=sum(K15:K32)` | 1029000000 | K15:K32 | — |
| C14 | PPN OAT | `=C13*11%` | 0 | C13 | — |
| L14 | BIAYA PERLITER | `=sum(I15:I32)` | 20580 | I15:I32 | — |
| I15 | Harga Dasar | `=D29` | 18000 | D29 | — |
| J15 | Harga Dasar | `=J10` | 50000 | J10 | — |
| K15 | Harga Dasar | `=I15*J15` | 900000000 | I15, J15 | — |
| C16 | OAT | `=sum(C9:C15)` | 19980 | C9:C15 | — |
| D16 | OAT | `=sum(D9:D14)` | 20535 | D9:D14 | — |
| E16 | OAT | `=SUM(E9:E15)` | 0 | E9:E15 | — |
| I16 | OAT | `=I14*7.5%*0` | 0 | I14 | Formula memakai referensi I14 yang kosong dan pengali 0; bukan perhitungan OAT aktif yang dapat diandalkan. |
| J16 | OAT | `=J15` | 50000 | J15 | — |
| I20 | PPN 11% | `=I15*11%` | 1980 | I15 | — |
| C26 | Nama INU     : | `=D8` | Katana | D8 | Nama INU konversi = D8 (Katana), tetapi harga dasar konversi tidak mengambil harga D9 secara otomatis. |
| C29 | Harga Dasar | `=18000` | 18000 | — | Konstanta 18.000, bukan referensi ke harga Katana D9=18.500 atau Aman 88 C9=18.000. Konfirmasi apakah harga khusus yang disengaja. |
| D29 | Harga Dasar | `=C29` | 18000 | C29 | Mengambil C29 sehingga basis biaya/HPP tetap 18.000; perubahan harga kandidat Katana tidak masuk ke HPP. |
| C30 | PPN | `=C29*11%` | 1980 | C29 | — |
| L33 | LABA KOTOR | `=L8-L13` | 266000000 | L8, L13 | — |
| L34 | SELISIH PPN | `=K12-K20` | 29,333,333.33 | K12, K20 | — |
| C35 | ALL IN | `=SUM(C29:C34)` | 19980 | C29:C34 | — |
| L35 | LABA BERSIH | `=L33-L34` | 236,666,666.7 | L33, L34 | — |
| L36 | LABA BERSIH PERLITER | `=L35/J10` | 4,733.333333 | L35, J10 | — |
| C37 | Gross Profit | `=D29-C29-C31-C32-C33` | 0 | D29, C29, C31, C32, C33 | — |
| L37 | PERSENTASE | `=L35/L13` | 0.2299967606 | L35, L13 | Persentase = laba bersih / total biaya (bukan laba bersih / pendapatan). Definisi KPI harus dipastikan. |
| C39 | Net Margin | `=C37-C38` | 0 | C37, C38 | Formula masih tersisa dan menghasilkan 0 karena C37/C38; jangan jadikan keluaran operasional karena tabel margin Solar Bawah tidak digunakan. |
| C40 | PPH | `=C39*22%` | 0 | C39 | Formula PPh masih tersisa dan menghasilkan 0; tandai blok sebagai non-operasional untuk profil Solar Bawah. |
| C41 | Profit MUE | `=C39-C40` | 0 | C39, C40 | Formula Profit MUE masih tersisa dan menghasilkan 0; jangan gunakan sebagai metrik hasil Solar Bawah. |

## Lampiran B — katalog sel lengkap

Katalog seluruh 410 sel berisi nilai atau formula tersedia terpisah: [CSV katalog sel](KATALOG_CELL_AHAS_SISTEM_TERBARU.csv) dan [Workbook audit](KATALOG_AUDIT_AHAS_SISTEM_TERBARU.xlsx). Workbook audit memuat sheet Ringkasan, Formula Audit, Katalog Sel, dan Perubahan Versi.

---
**Batas interpretasi:** isi sel dan rumus di atas berasal dari workbook terbaru. Label seperti “mapping tidak konsisten” merupakan temuan hubungan antarsel yang terlihat, bukan kepastian bahwa kebijakan bisnis perusahaan salah. Keputusan final harus mengikuti konfirmasi PIC dan praktik transaksi Dinar.