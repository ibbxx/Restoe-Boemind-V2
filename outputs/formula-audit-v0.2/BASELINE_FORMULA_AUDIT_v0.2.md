# Baseline Formula Audit v0.2

Tanggal: 14 Oktober 2026. Status keseluruhan: **BELUM TERUJI**; pemeriksaan struktur awal sudah dilakukan, evaluasi independen belum dijalankan.

## Identitas baseline

Nama yang diminta: `AHAS Sistem(4).xlsx`. File dengan nama tersebut tidak ditemukan dalam pencarian nama file di Documents dan Downloads. File lokal `AHAS Sistem.xlsx` pada workspace v4 cocok tepat dengan hash sumber yang dicatat dalam `ANALISIS_MENDALAM_AHAS_SKP_DINAR_TERBARU.md`. Pemakaian baseline ini berdasarkan identitas byte, bukan asumsi nama atau tanggal modifikasi.

| Kandidat | SHA-256 | Keputusan |
|---|---|---|
| `evaluasi vendor v4/AHAS Sistem.xlsx` | `efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc` | Baseline yang cocok dengan audit terbaru; TERVERIFIKASI untuk identitas hash |
| `EVALUASI VENDOR v3/AHAS Sistem.xlsx` | `4235dc6a0d837a7bf5fe2e50d7c5684c4653b619179eefc1608b53ff33a8ec55` | Baseline pembanding lama; tidak dipakai menggantikan baseline terbaru |

Workbook terbaru memiliki worksheet `AHAS INU` dan `AHAS Solar bawah`, keduanya visible. Cakupan yang dinyatakan audit lama: A1:L42 dan A1:L41. Pemeriksaan seluruh elemen formula XML menemukan 86 sel formula INU dan 80 Solar; lokasi semua formula dan cakupan populated cells masih harus diperiksa oleh ekstraksi lengkap. INU juga memiliki sel format kosong E46, sehingga batas sel XML tidak boleh disamakan dengan cakupan isi aktif.

## Artefak yang dibaca dan harus tetap immutable

| File | SHA-256 awal |
|---|---|
| KATALOG_AUDIT_AHAS_SISTEM_TERBARU.xlsx | `670b2c1ae781ff4af31d9f7ae88257e80489f860b946b6acae61a6a9bf44ffe4` |
| KATALOG_CELL_AHAS_SISTEM_TERBARU.csv | `a9b96abdb01b24c24f77cee2b68a6d94a04987fa971ed5617b64915adb3642f8` |
| ANALISIS_MENDALAM_AHAS_SKP_DINAR_TERBARU.md | `a27257e5f952e24cbf1d66169f05755b73e33c35144b24cc024f361787ddc821` |
| MATRIKS_UJI_FORMULA_PROCUREMENT_v0.1.xlsx | `3b30899632d0e89ad0e8b8e45321f40c1fd3c69dcb1f9838effd5b19eeba1c70` |
| PRD_SISTEM_EVALUASI_VENDOR_KONVERSI_JAGAD_AHS.md | `2ca6018017a89f7660898186ab047f053b92bb9cb031ef61abb8b94ddf519a86` |
| FLOWCHART_PROSES_BISNIS.md | `35a8b62baf12bdd5afb108ea4cfd32daaf25f27adcddf922d7527d75cb73d772` |
| FLOWCHART_PERHITUNGAN_AHS.md | `7b43c351d42937c7a0c78445eccdfaea86494482162167bc152714181a44d6d8` |
| SPESIFIKASI_WORKSHEET.md | `54a97fe08c9a6f1765e830e51766bbee6e2c8e51e95166fb66c7aaadd6c1b12a` |

## Rekonsiliasi struktur awal

| Ukuran | INU | Solar Bawah | Total | Makna |
|---|---:|---:|---:|---|
| Sel dengan elemen XML `<f>` | 86 | 80 | 166 | Sel formula, termasuk shared followers |
| Sel dengan teks formula | 44 | 38 | 82 | Rumus standalone atau anchor shared formula |
| Shared followers tanpa teks lokal | 42 | 42 | 84 | Formula relatif dari anchor; bukan input manual |

Hitungan ini berasal dari XML sumber, bukan dari menghitung baris katalog terdahulu. Angka 82 tidak merupakan inventaris lengkap sel formula. Angka referensi/dependensi harus dihitung lagi setelah ekspansi shared formula dan rentang. Angka 226 belum diverifikasi. Angka 167 pada dokumen final merujuk hash baseline lama dan belum direkonsiliasi dalam pemeriksaan awal ini.

## Temuan awal yang terbukti dari teks XML

| ID | Sel/area | Bukti | Status temuan |
|---|---|---|---|
| B01 | Semua worksheet | Shared followers memiliki `<f t="shared" si="..."/>` | TERVERIFIKASI: followers harus diinventarisasi, bukan disebut input tetap |
| B02 | INU D13 | `D10*0.3%`, tidak ada faktor nol | GAGAL UJI: komentar audit tentang faktor nol bertentangan dengan formula |
| B03 | INU C33 | `C30*0.3%`, tidak ada faktor nol | GAGAL UJI: komentar audit tentang faktor nol bertentangan dengan formula |
| B04 | INU C39 | `D30*0.25%`, tidak ada faktor nol | GAGAL UJI: komentar audit tentang faktor nol bertentangan dengan formula |
| B05 | INU D11/D15; Solar D10/D14 | Shared followers pajak penawaran | GAGAL UJI: penyebutan sebagai nilai input tetap perlu dikoreksi pada audit lanjutan |
| B06 | INU J17:J33; Solar J16:J32 | Shared followers kuantitas berantai | GAGAL UJI: komentar audit bahwa kuantitas biaya sebagian input tetap perlu diuji ulang |
| B07 | Solar C38:C41 | C38 bukan formula; C39:C41 masih formula | NON-OPERASIONAL untuk Profit MUE Solar sesuai ketentuan final; angka hasil belum diuji independen |

`GAGAL UJI` di sini mengacu pada ketepatan komentar/inventaris audit, bukan bukti bahwa hasil aritmetika formula workbook gagal.

## Batas tahap ini

Belum ada hasil perhitungan ulang independen, test perubahan input, penelusuran transitif, pemeriksaan siklus menyeluruh, atau uji engine aplikasi. Nilai tersimpan tidak dipakai sebagai bukti recalculation. Formula kritis masih BELUM TERUJI. Audit **belum selesai**.

Aturan aplikasi tetap: pemilihan penawaran manual, HPP AHS input manual, profil INU/Solar independen, Profit MUE operasional hanya INU. Hubungan formula sumber ke HPP tidak mengesahkan auto-binding pada aplikasi.

Ekstraksi/pengujian lanjutan menunggu persetujuan metode pengganti runtime spreadsheet yang tidak tersedia. Baseline ini tidak mengubah workbook sumber, PRD, flowchart, spesifikasi, atau UI.
