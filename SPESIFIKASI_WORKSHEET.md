# Spesifikasi worksheet Evaluasi Vendor, Konversi Satuan Jagad, dan AHS

Revisi 8 — 14 Oktober 2026. **Diselaraskan dengan PRD v1.7-draft dan SOP Procurement Proyek Tonasa.** Dokumen rancangan; implementasi dan acceptance test aplikasi belum dilakukan.

Workspace diperiksa: `/Users/ibnufajar/Documents/ibnu/RBI/SISTEM EVALUASI VENDOR/evaluasi vendor v4`. Sumber tersedia: [AHAS Sistem.xlsx](AHAS%20Sistem.xlsx) dan tiga dokumen rancangan. SHA-256 workbook: `4235dc6a0d837a7bf5fe2e50d7c5684c4653b619179eefc1608b53ff33a8ec55`. Audit XML menemukan 86 formula INU + 81 Solar Bawah, 359 referensi langsung setelah ekspansi rentang, tanpa siklus atau formula lintas sheet. Ini audit struktur, bukan pengujian aplikasi atau pengesahan pajak.

**Batas scope SOP:** `SOP Procurement Proyek Tonasa.pdf` adalah pedoman tim untuk menentukan kelayakan vendor. MVP sistem tidak membuat checklist, scoring, status lulus/gagal, atau penilaian delapan aspek SOP. Sistem hanya menghitung angka dari input/formula yang dimasukkan pengguna. Tim menentukan kandidat yang layak di luar aplikasi; pengguna memilih penawaran secara manual sebagai input kalkulasi.

Penanda pada ketiga dokumen: **R** = kebutuhan pengguna yang sudah ditetapkan; **F** = fakta workbook; **U** = rekomendasi desain aplikasi; **K** = keputusan bisnis/parameter yang masih perlu ditetapkan pengguna. Inventaris: [FLOWCHART_PERHITUNGAN_AHS_v7.md](FLOWCHART_PERHITUNGAN_AHS_v7.md). Alur kerja: [FLOWCHART_PROSES_BISNIS_v7.md](FLOWCHART_PROSES_BISNIS_v7.md).

## 1. Satu workspace dan tiga tabel

**R:** satu analisis membuka satu workspace dengan Evaluasi Vendor, Konversi Satuan Jagad, dan AHS. Sistem menghitung komponen/total harga dan menampilkan perbandingan angka; kelayakan vendor berdasarkan SOP ditentukan tim di luar aplikasi. Pengguna memilih penawaran secara manual untuk diteruskan ke Konversi. Setelah melihat hasil Konversi Jagad, pengguna menetapkan harga dasar HPP AHS secara manual. Profil INU/Solar Bawah tetap berada dalam satu tabel Konversi; satu mesin formula digunakan di luar UI.

**U:** Evaluasi Vendor di kiri atas, Konversi di kiri bawah, AHS di kanan pada layar lebar; layar kecil dapat menumpuk blok dalam workspace yang sama. `image.png` tidak tersedia di workspace saat audit ini. Rujukan visual revisi sebelumnya berasal dari folder v3 dan tidak dijadikan bukti formula atau klaim verifikasi visual revisi ini.

| Tabel | Data inti dan perilaku R/U |
|---|---|
| Evaluasi Vendor | Kandidat/revisi penawaran, harga, komponen, formula/total, satuan, konteks dan catatan perhitungan; sistem menampilkan perbandingan angka. Tim menentukan kelayakan vendor di luar aplikasi, dan pengguna memilih penawaran secara manual. Kandidat tidak dibatasi tiga nama contoh. |
| Konversi Satuan Jagad | Profil aktif, sumber penawaran terpilih, basis supplier S, basis biaya B, komponen/total dan Profit MUE; dua paket default, mapping, dan override independen. |
| AHS | Basis HPP H, input harga jual/volume, biaya per unit/tetap/persentase, agregat, pendapatan, pajak dan laba. H ditentukan manual oleh pengguna setelah meninjau hasil Konversi; bukan otomatis B/S atau total penawaran. |

**F:** INU `C30=D10`, `D30` manual dalam workbook, `I16=D30`; Solar `C29=18000`, `D29=C29`, `I15=D29`. Ini fakta formula sumber. **R:** aplikasi tidak otomatis mengikat H ke B; setelah meninjau hasil Konversi, pengguna memasukkan HPP AHS sendiri. H tetap node/input terpisah dengan provenance ke Calculation Run Konversi yang menjadi dasar pertimbangan.

## 1.1 Batas evaluasi vendor

Sistem tidak menilai delapan aspek SOP, memvalidasi dokumen, atau menyatakan vendor layak/tidak layak. Tim melakukan proses tersebut di luar aplikasi. Sistem hanya menghitung harga dan komponen dari kandidat yang dimasukkan.

## 2. Node, identitas, dan ruang lingkup

Alias berikut untuk membaca rancangan; referensi persisten memakai ID, bukan alias, alamat Excel, atau posisi kolom.

| Alias U | Makna dan lingkup | Provenance F |
|---|---|---|
| O | Harga/komponen dari kandidat/revisi yang dipilih pengguna secara manual sebagai input kalkulasi; kelayakan kandidat ditentukan tim di luar sistem | Harga kandidat INU C10:E10; Solar C9:E9 |
| S | `conversion.supplier_base`, per profil | INU C30; Solar C29 |
| B | `conversion.cost_base`, per profil | INU D30; Solar D29 |
| H | `ahs.hpp_base`, input harga dasar HPP yang ditetapkan manual oleh pengguna | INU I16 / Solar I15 adalah lokasi formula sumber historis, bukan binding operasional otomatis |
| ΔINU | Tidak menjadi node operasional default pada rancangan terbaru; tidak dibuat dari selisih angka contoh. | Bukan formula Excel dan bukan basis untuk HPP AHS. Target solver INU menghitung B/D30 langsung dari formula Profit MUE aktif. |

**R/U:** `analysis_id`, `table_id`, `profile_id`, `candidate_id`, `row_id`, `column_id`, `node_id`, `formula_id` stabil. `display_order` terpisah; tipe/unit/izin melekat ke node. Sheet/sel/hash workbook hanya provenance.

**U:** nama vendor operasional di Konversi/AHS mengikuti `selection.candidate_id`; nama dan sumber harga ditampilkan bersama agar dapat diperiksa. Referensi metadata asli K4=C9/C27=D9 INU dan K3=C8/C26=D8 Solar tetap ada pada tinjauan sumber, bukan fallback nama vendor operasional. Ini adaptasi metadata aplikasi, bukan bukti bahwa workbook sudah memilih kandidat yang sama.

**U:** kandidat dan penawaran dimiliki analisis dan dipakai bersama dua profil. Pergantian profil konversi tidak menimpa nilai atau formula penawaran. Formula pajak/total penawaran berversi per penawaran dan mencerminkan sumber penawarannya; kandidat baru memilih pola secara eksplisit karena sumber INU sendiri berbeda antarkandidat. Biaya, mapping, dan override khusus profil disimpan per `profile_id`; harga jual/volume bersama hanya jika node dinyatakan bersama. AHS menampilkan komponen profil aktif dalam tabel yang sama.

## 3. Tiga lapisan formula dan satu penulis per target

| Lapisan U | Isi dan kebijakan |
|---|---|
| Formula asli Excel | Teks asli dan ekspansi shared formula, sheet/sel, input manual/konstanta, versi/hash immutable; dapat ditinjau/dipulihkan. Angka contoh bukan input proyek baru. |
| Mapping aplikasi | Source/target ID, transformasi, unit, profil/scope kandidat, versi dan status draft/disahkan/dinonaktifkan; draft dapat disimulasikan berlabel, belum mendukung hasil final. |
| Override operasional | Formula kustom target, referensi ID, alasan, aktor, aktivasi dan versi; perubahan ekspresi/mapping memerlukan pengesahan versi baru. |

**U:** setiap target mempunyai tepat satu writer aktif. Prioritas: override aktif dan valid → mapping aktif dan valid → default sumber yang kompatibel dengan peran operasional. Draft tidak otomatis mengganti versi disahkan; preview draft memiliki run/revisi sendiri. Dua mapping aktif untuk target sama ditolak sebagai konflik. Semua mapping adalah edge pada graf mesin yang sama.

**R/U:** default yang mengunci kandidat contoh (INU C30=D10) atau konstanta Solar (C29=18000) tersedia dalam tinjauan sumber, tetapi tidak menjadi fallback diam-diam bagi hasil vendor pilihan. Reset/hilangnya mapping wajib menyebabkan `WAITING_MAPPING`. Kandidat nonpilihan hanya memengaruhi AHS melalui custom reference eksplisit ber-ID yang terlihat di editor.

## 4. Register mapping harga per profil

Register ini otoritatif bagi ketiga dokumen. **Formula asli** menunjukkan bukti; **mapping usulan/menunggu validasi** belum aturan disahkan. Unit O/S/B/H harus sama (misalnya Rp/liter setelah K3 disahkan), tanpa konversi fisik implisit.

### 4.1 INU

| ID / Profil | Sumber harga vendor | Jenis nilai sumber | Target Konversi | Formula/transformasi | Target AHS | Formula sumber terkait | Status | Dampak perubahan input | Catatan |
|---|---|---|---|---|---|---|---|---|---|
| M-I0 / INU | AKR D10 | Harga dasar | S (C30) | S=D10 | H input manual pengguna | C30=D10; I16=D30 | Formula asli F-I1/F-I2 | D10 mengubah S dan dependensi Konversi; H tidak berubah otomatis | Bukti sumber, bukan selection runtime |
| M-I1 / INU | O kandidat/revisi yang dipilih pengguna secara manual; kelayakan sudah dipertimbangkan tim di luar sistem | Harga dasar/komponen yang dipetakan | S | S=O | Ke kalkulasi profil INU | Adaptasi C30=D10; default tetap disimpan | Mapping aplikasi; divalidasi sesuai formula dan unit | Harga/revisi terpilih mengubah S dan turunan Konversi | Bukan all-in; bukan HPP AHS otomatis |
| M-I2 / INU | Input Konversi INU dengan S yang berasal dari O | Basis untuk formula target Profit MUE | B/D30 | **Target solver mencari nilai B/D30 yang memenuhi `50,00 ≤ Profit MUE < 51,00`** | H input manual terpisah | D30 input pada workbook; I16=D30 fakta sumber saja | Requirement target-solver dikonfirmasi; presisi/step dan batas pencarian perlu konfigurasi | Perubahan harga vendor memicu recalculation target; H tidak berubah otomatis | Jangan gunakan `B=S+ΔINU` atau delta dari angka contoh sebagai asumsi |
| M-IM / INU | Pengguna melakukan override eksplisit atas hasil rekomendasi B/D30 | Nilai Biaya manual dengan validasi target | B | B=manual_override; validasi ulang Profit MUE | H input manual pengguna | D30 tetap input sumber; hubungan I16=D30 hanya fakta workbook | Override opsional; bukan default | Recalculate MUE dan status validasi; H tidak berubah otomatis | Override di luar rentang target tidak boleh dianggap memenuhi target |
| M-IX / INU | Komponen penawaran terpilih yang disebut satu per satu | Alternatif sumber basis B | B | B=SUM(anggota ID dikonfigurasi) | H input manual terpisah | Tidak ada rumus ini di D30 | Alternatif opsional | B/Profit MUE recalculated; H tidak berubah otomatis | Buktikan komponen sudah/belum termasuk; cegah pajak/biaya ganda |

**R/U:** O dari kandidat/revisi yang dipilih tim mengalir ke S melalui mapping Konversi yang valid. Pada profil INU, target solver mencari nilai B/D30 yang memenuhi target Profit MUE memakai formula aktif dan input terkini. Selisih contoh `21880−20000` tidak digunakan sebagai delta, markup, atau default. Sesudah hasil Konversi ditampilkan, HPP AHS ditetapkan pengguna secara manual dan ditautkan ke Calculation Run sebagai konteks saja; tidak ada H=B otomatis.

### 4.2 Solar Bawah

| ID / Profil | Sumber harga vendor | Jenis nilai sumber | Target Konversi | Formula/transformasi | Target AHS | Formula sumber terkait | Status | Dampak perubahan input | Catatan |
|---|---|---|---|---|---|---|---|---|---|
| M-S0 / Solar | Tidak ada; konstanta 18000 | Bukan harga vendor terikat | S (C29) | S=18000; B=S | H input manual pengguna | C29=18000; D29=C29; I15=D29 | Formula asli F-S1/F-S2 | Harga kandidat tidak mengubah basis source; alur aplikasi memakai mapping terpisah | Bukti historis; H bukan auto-binding |
| M-S1 / Solar | O kandidat/revisi yang dipilih pengguna secara manual; kelayakan sudah dipertimbangkan tim di luar sistem | Harga dasar/komponen yang dipetakan | S | **S=O; B=S bila aturan Konversi ini diaktifkan** | H input manual pengguna | Override operasional C29; D29=C29/I15=D29 tetap tercatat sebagai provenance sumber | Mapping Konversi; unit/scope divalidasi | O+1 memperbarui Konversi; H tetap dan konteksnya NEEDS_REVIEW | Profit MUE Solar tidak operasional; konstanta 18000 tetap untuk audit |
| M-SX / Solar | O serta komponen tertentu jika B memang berbeda | Harga dasar + komponen | B | Formula/konfigurasi Konversi khusus yang didefinisikan pengguna | H input manual pengguna | Override hubungan D29=C29; H independen | Alternatif; validasi unit/komposisi diperlukan | B/hasil Konversi berubah; H tidak berubah otomatis | Profit MUE Solar tetap non-operasional |

**Alternatif all-in U/K:** kedua profil dapat menyediakan mapping total penawaran tersendiri setelah komposisi, pajak dan unit dibuktikan. Tidak direkomendasikan `H=offer.total` atau pembagian total dengan 1.11 secara umum. Anggota total kandidat D berbeda; memasukkan total termasuk PPN ke B sementara AHS menghitung PPN beli lagi dapat menggandakan pajak. K1/K4 harus menentukan transformasi yang sah.

### 4.3 Penetapan harga dasar HPP AHS (H) — aturan operasional [R]

Urutannya adalah **input kandidat yang sudah dipertimbangkan tim → perhitungan harga oleh sistem → pengguna memilih penawaran secara manual → Konversi Jagad → pengguna menentukan HPP AHS**. Tidak ada checklist atau penilaian SOP di dalam aplikasi. Setelah hasil Konversi dihitung, pengguna memasukkan nilai H sebagai harga dasar HPP AHS.

- H bukan mapping otomatis dari B atau S. Nilai H yang dimasukkan pengguna adalah input operasional AHS.
- Simpan provenance berupa kandidat/revisi penawaran terpilih, profil Konversi, dan Calculation Run yang dilihat pengguna saat menetapkan H.
- Jika harga vendor, revisi penawaran, profil, mapping, atau run Konversi berubah setelah H ditetapkan, jangan menimpa H. Tandai konteks H/AHS `NEEDS_REVIEW` hingga pengguna meninjau hasil terbaru dan memutuskan apakah H perlu diperbarui.
- Workspace baru membiarkan H kosong; tidak menggunakan D30=21880, C29=18000 atau cached value sebagai HPP default. H kosong membuat hasil AHS yang bergantung kepadanya nonfinal.
- Formula sumber workbook `I16=D30` dan `I15=D29` tetap tersimpan sebagai bukti sumber. Relasi tersebut tidak memaksa auto-binding operasional aplikasi.

## 4.3 Harga jual/volume editable

**F:** INU I11=25900/1.11, Solar I10=25900/1.11; volume J11/J10=50000. **U:** M-J1 menyediakan input `sale_gross_input` dan `volume`, dengan `sale_base=sale_gross_input/sale_divisor`. Pembagi memakai kebijakan disahkan, tidak otomatis mengikuti label pajak. Konstanta 25900 tetap di default sumber; input analisis baru kosong. Basis harga jual, pembagi dan rounding mengikuti K4.

## 5. Perubahan harga, pilihan, profil, dan reset

| Pemicu R/U | Perilaku |
|---|---|
| Pilihan input manual | Sistem menyimpan referensi kandidat/revisi yang dipilih pengguna untuk kalkulasi, nilai hasil dan Calculation Run. Tidak menyimpan penilaian kelayakan atau alasan SOP. |
| Harga/komponen kandidat berubah | Perhitungan dan perbandingan angka diperbarui; pilihan input tidak berubah otomatis. Histori hasil lama dipertahankan dan Konversi dihitung ulang setelah pengguna memilih/konfirmasi input yang akan digunakan. |
| Vendor terpilih berubah | O mengikat kandidat/revisi yang dipilih pengguna secara eksplisit; profil Konversi recalculated. H manual tetap tersimpan namun menjadi NEEDS_REVIEW sampai pengguna meninjau ulang konteksnya. |
| Kandidat lain berubah | Total penawarannya berubah; AHS tidak berubah kecuali custom reference eksplisit. |
| Ganti profil | Pilih state profil terkait tanpa menyalin/menimpa profil lain. Hitung dari revisi penawaran terkini; cache profil nonaktif stale bila dependensinya berubah dan dihitung sebelum dipakai lagi. |
| Edit formula | Parse, resolve, cek izin/unit/siklus; buat override versi baru, tampilkan dampak, hitung turunannya. Perubahan tidak otomatis mewarisi persetujuan versi lama. |
| Reset default | Pratinjau formula/default/input/dependent; buat revisi baru; nonaktifkan mapping/override writer target dan aktifkan sumber versi pilihan. Jika memutus jalur vendor, WAITING_MAPPING. |

**U:** reset tidak menghapus input manual tersimpan. D30 asli adalah input: reset mengaktifkan nilai B yang tersimpan atau EMPTY bila belum ada, bukan mengisi 21880. Reset C29 memulihkan formula =18000 untuk tinjauan sumber, tanpa menghapus O. Jika entitas referensi default hilang, MISSING_REFERENCE ditampilkan; tidak menciptakan kandidat/nilai diam-diam. Cakupan reset sel/profil/mapping disebut eksplisit; reset satu profil tidak mereset lainnya.

## 6. Struktur dinamis dan agregasi

| Operasi R/U | Aturan ketiga tabel |
|---|---|
| Tambah kandidat/baris/kolom | Buat ID, tipe/unit/sumber/izin/formula awal eksplisit. Angka contoh bukan penawaran sah; posisi tidak otomatis menentukan anggota total. |
| Edit | ID tetap; perubahan tipe/unit/formula memvalidasi dependent. Tarif, total dan persen tidak ditafsirkan ulang tanpa keputusan. |
| Urutkan | Hanya display_order; referensi, pilihan, anggota agregat dan nilai tidak berubah. |
| Hapus | Lindungi identitas/output inti; periksa formula aktif, mapping, pilihan, agregat dan kebutuhan reset. Referensi harus diganti/dilepas eksplisit sebelum hapus; provenance/histori tetap melalui arsip ID. |
| Ubah anggota total | Anggota node ID, daftar/dampak terlihat; cegah subtotal + penyusunnya dihitung dua kali; anggota baru harus dinyatakan. |

**F:** total INU C17=SUM(C10:C16), D17=SUM(D10:D15), E17=SUM(E10:E16); Solar bergeser satu baris. D mengecualikan baris BPH. Tinjauan sumber mempertahankan anggota ini; penawaran baru tidak diseragamkan tersembunyi.

**U/K7:** sumber nilai (manual/referensi/formula) terpisah dari jenis amount: per unit `unit_rate×quantity_ref`; tetap `fixed_value` sekali; persentase `rate_fraction×basis_node`. Basis, satuan dan apakah formula menghasilkan tarif/total wajib jelas; hasil total tidak dikalikan volume lagi. Seluruh biaya sumber memakai I×J dan biaya/liter SUM tarif I. Untuk campuran jenis biaya, rekomendasi `total_cost/volume` hanya diaktifkan sebagai override disahkan K7; SUM tarif asli tetap tersimpan. Volume nol menghasilkan error indikator per unit.

## 7. Mesin formula, status, kalkulasi ulang

**R/U:** mesin di luar UI menerima snapshot input/pilihan/profil/formula/mapping/struktur. Mendukung +, −, ×, /, tanda kurung, persen, SUM dan referensi ID/agregat. Evaluator tidak menjalankan kode bebas atau membaca node tanpa izin. UI menampilkan hasil mesin, tidak memiliki aritmetika bisnis sendiri.

Satu mutasi: validasi → resolve ID → tentukan satu writer per target → ubah graf termasuk membership/binding pilihan → deteksi siklus → hitung node terdampak secara topologis → publikasikan run dengan revisi sama. Profil nonaktif menjadi stale bila dependensinya berubah. Run lama tidak boleh menimpa revisi baru. Full/incremental harus sama untuk snapshot identik; cabang independen boleh valid walau cabang lain gagal.

| Status R/U | Arti |
|---|---|
| EMPTY | Input wajib belum ada; bukan nol. |
| ZERO_EXPLICIT | Nol eksplisit/hasil nol, dapat valid jika kebijakan menerima nol. |
| ERROR | Sintaks, missing reference, unit tidak cocok, konflik writer, pembagian nol, siklus; target/dependent tidak valid. |
| WAITING_MAPPING | Mapping wajib belum disahkan, hilang atau tidak sesuai scope; preview berlabel boleh terlihat. |
| VALID | Berhasil dihitung untuk revisi aktif, dependency valid dan mapping wajib disahkan. |

`freshness` current/stale, `decision_status` approved/needs_review, `business_status` dan status simpan terpisah dari status nilai. Angka simulasi yang berhasil dihitung belum berarti final. Final memerlukan mapping/formula sah, input wajib lengkap, H manual dengan konteks Konversi yang ditinjau, dan run terkini; hasil lama hanya di histori.

ZERO_EXPLICIT menyatakan keadaan nilai dan dapat berpasangan dengan hasil evaluasi VALID; nol yang sah tidak ditampilkan sebagai EMPTY. Input numerik negatif mengikuti aturan komponen yang disahkan, bukan otomatis dikoreksi menjadi nol.

**U:** siklus baru ditolak dengan jalurnya; siklus dalam draft/import/snapshot menandai seluruh siklus dan dependent ERROR. Missing reference bukan 0 dan tidak memilih kandidat pengganti. Tinjauan sumber mempertahankan perlakuan kosong Excel pada SUM/header; operasional membedakan sel struktural tidak berlaku dari input wajib kosong (K4/K7). Anomali OAT INU I17=I15*7.5%*0 / Solar I16=I14*7.5%*0 dipertahankan sebagai bukti dan perlu validasi.

**U/K4:** gunakan desimal untuk uang, bedakan tarif/unit/volume/persen/total; presisi, rounding dan toleransi uji disahkan, tidak disimpulkan dari format tampilan. Tidak ada faktor konversi fisik tanpa K3.

## 8. Data konseptual dan histori

| Entitas U | Isi |
|---|---|
| Analysis | ID, metadata, profil aktif, revision, tiga tabel inti. |
| Table/Row/Column/Node | ID, label, tipe/unit/izin/order, sumber nilai, scope bersama/profil. |
| Candidate/OfferRevision/OfferValue | Kandidat, snapshot revisi, component ID, nilai/formula, unit, dan kelengkapan. |
| ProcurementChecklist/ComplianceReview | Tidak termasuk domain model MVP; sistem tidak menyimpan status kepatuhan atau hasil kelayakan vendor. |
| SelectedOfferReference | Referensi kandidat/revisi yang dipilih pengguna sebagai input kalkulasi, formula/pajak, Calculation Run, waktu; tidak merepresentasikan keputusan kelayakan vendor. |
| ProfileState | Input khusus profil, mapping/override, basis manual/Δ beserta konteks kandidat, freshness. |
| SourceFormula/FormulaOverride | Default immutable/hash/sheet/sel/expression/versi; override target/referensi ID/status/alasan/aktivasi terpisah. |
| MappingVersion/Configuration | Source/target/jenis harga/transformasi/unit/scope, versi, status/alasan; satu jenis pengguna pada MVP. |
| Aggregate/Membership | Anggota node ID, tanpa dependensi posisi. |
| CalculationRun | Snapshot revision, kandidat/revisi penawaran, profil, versi formula/mapping/engine/policy, output/error/status per node, waktu. |
| ChangeEvent | Aktor/waktu/revisi/operasi/ID/sebelum-sesudah/alasan/run terkait, termasuk sort/reset. |

**R/U:** histori meliputi data, formula, mapping, profil, pemilihan, struktur, reset, dan hasil. Profit MUE dan laba AHS punya node/output masing-masing dalam run yang sama. Restore membuat revisi baru, tidak menghapus histori. Gagal simpan terlihat sebagai belum tersimpan. K6/K8/K9 menentukan review hasil kalkulasi, mode simpan, retensi, batas SOP di luar sistem, dan pemulihan; mutasi pada revisi usang harus ditolak/diselesaikan eksplisit agar tidak menimpa diam-diam. Ini model konseptual, belum memilih teknologi penyimpanan.

## 9. Keterlacakan kebutuhan dan uji penerimaan

Skenario implementasi kelak, **belum dijalankan sebagai tes aplikasi**. F-I/F-S/F-A merujuk register bukti dokumen perhitungan; M merujuk bagian 4.

| Kebutuhan | Formula sumber | Mapping/desain | Uji dan hasil yang harus terlihat |
|---|---|---|---|
| R01 asal harga pilihan | F-I1; kandidat Solar C9:E9 | O, M-I1/M-S1 | T01 kandidat keempat ikut perhitungan/perbandingan; pilihan input dilakukan manual dan provenance tersimpan. |
| R02 target tiap profil | F-I1/F-S1 | M-I1→S, M-S1→S | T02 lihat provenance; O/S/B/H node terpisah walau nilainya sama. |
| R03 perbedaan profil | F-I2 D30 manual; F-S2 D29=C29 | Target solver INU; mapping Konversi Solar; H manual di kedua profil | T03 tinjauan sumber mereproduksi default; Profit MUE target hanya INU; HPP tidak otomatis mengikuti B. |
| R04 penetapan HPP setelah Konversi | F-I2 I16=D30; F-S2 I15=D29 (sumber saja) | H=input manual; konteks run Konversi | T04 ubah hasil Konversi: H tidak berubah otomatis, AHS NEEDS_REVIEW sampai pengguna meninjau. |
| R05 ganti vendor | Workbook sumber tidak memiliki proses pemilihan vendor tim | Keputusan tim ber-ID | T05 ranking harga diperbarui tetapi O/S tidak pindah otomatis; H tetap dan konteksnya NEEDS_REVIEW. |
| R06 harga pilihan berubah | F-I1/F-I3/F-S2/F-S3/F-A | O→Konversi; H manual | T06 perubahan harga memicu perhitungan harga dan Konversi; H tidak ikut berubah otomatis dan histori lama tetap. |
| R07 edit formula | Inventaris 167 formula | Override/satu writer | T07 hitung dependent formula sah; konflik/siklus ditolak, persetujuan lama tidak diwarisi ekspresi baru. |
| R08 profil nonaktif | Dua sheet independen | ProfileState | T08 edit INU, pindah Solar, kembali: override/input utuh; cache usang dihitung ulang. |
| R09 reset aman | F-I2 input D30; F-S1 konstanta C29 | Kebijakan reset | T09 C29 kembali =18000 tanpa menghapus O; D30 kembali input tersimpan/EMPTY, bukan contoh21880; mapping wajib yang lepas→WAITING_MAPPING. |
| R10 cegah valid palsu | Mapping vendor→Konversi dan H manual memiliki status terpisah | Status mesin | T10 mapping Konversi draft, target INU tidak tercapai atau H kosong tidak memberi hasil final; angka cache bukan hasil revisi terkini. |
| R11 cabang profit terpisah | F-I3/F-S3/F-A | Profit MUE INU operasional; Solar MUE audit-only; AHS terpisah | T11 perubahan S/target-solver memperbarui Konversi, H manual tetap; tidak ada profit gabungan. |
| R12 dependency sah | 359 edge sumber | Graf lintas tabel | T12 full/incremental identik; kandidat nonpilihan tidak mengubah AHS tanpa custom reference. |
| Struktur dinamis | SUM anggota sumber | ID/membership/izin | T13 tambah/edit/urut pada tiga tabel; sort tidak mengubah nilai; hapus node dipakai ditolak; anggota baru eksplisit. |
| Evaluasi SOP Procurement Tonasa | SOP Procurement Proyek Tonasa.pdf, bagian 4 tahap 2–7 dan bagian 5.1–5.5 | SOP menjadi prosedur tim di luar aplikasi; tidak ada checklist atau scoring vendor di sistem | T22–T24: pastikan modul tidak memiliki checklist, skor, status kelayakan vendor, atau workflow SOP; semua keputusan tersebut berada di luar sistem. |
| Jenis biaya | F-A I×J | K7, amount_kind | T14 fixture: per unit2×volume10=20; tetap2=2; 10% atas total20=2. Ini data uji, bukan tarif bisnis. |
| Error/kosong/unit | Header kosong, pembagi volume | Validasi | T15 EMPTY/ZERO_EXPLICIT/missing ref/divide-zero/unit mismatch berbeda; dependent tidak valid palsu. |
| Histori/revisi | Tidak disediakan sumber | Event/Run | T16 perubahan data/pilihan/mapping/formula/profil/reset terlacak; run lama tidak menimpa revisi baru; gagal simpan tidak disebut tersimpan. |
| Jual/volume editable | I11/I10=25900/1.11; J11/J10 | M-J1 | T17 ubah input jual/volume→pendapatan/biaya/laba dihitung ulang; default sumber tetap. |
| All-in/pajak | Total berbeda; PPN beli dihitung lagi | K1/K4/K7 | T18 total termasuk pajak tidak menjadi B tanpa komposisi/basis sah; tidak ada /1.11 otomatis. |
| Target Profit MUE INU | F-I3 / formula cabang Profit MUE INU | Target solver atas B/D30 | T19: utamakan Rp50,00; nilai aktual valid hanya `[50,00, 51,00)`; tidak aktif pada Solar Bawah. |
| Pemilihan penawaran sebagai input | Harga/hasil kalkulasi | SelectedOfferReference | T20: pengguna memilih penawaran manual; tidak ada penilaian kelayakan atau auto-selection. |
| H manual dan perubahan konteks | H input terpisah; run Konversi disimpan sebagai konteks | H manual + freshness/NEEDS_REVIEW | T21: hasil Konversi berubah tidak menimpa H; pengguna meninjau dan menentukan apakah H perlu diperbarui. |

Untuk T06, jika biaya sumber tetap per unit, volume q tetap, tarif sumber 11% hanya sebagai fixture: H+1 menaikkan total biaya 1.11q, menurunkan selisih PPN 0.11q, menurunkan laba bersih q. Sensitivitas diturunkan dari rumus sumber, bukan pengesahan tarif.

## 10. Keputusan bisnis, rekomendasi dan risiko

| ID | Keputusan | Rekomendasi U | Risiko tanpa keputusan |
|---|---|---|---|
| K1 | Field pembanding harga vendor dan komponen O→S per profil | Tampilkan hasil perhitungan/ranking; tim memilih manual; mapping O→S tervalidasi; all-in perlu komposisi jelas | Basis salah atau pajak/biaya ganda. |
| K2 | Presisi/step, batas pencarian, rounding B/D30 INU dan aturan B Solar dalam Konversi | Target solver INU menggunakan formula aktif; H AHS tetap manual | Tanpa parameter pencarian nilai target tidak dapat ditentukan; H tidak boleh mengikuti B otomatis. |
| K3 | Unit/arti Konversi Jagad/faktor fisik | O/S/B/H bersatuan sama; tanpa faktor otomatis | Dimensi salah meski angka terlihat valid; mapping unit berbeda diblokir. |
| K4 | Pajak/faktor nol/OAT/jual/pembagi/presisi/rounding | Sumber tetap untuk audit, aturan operasional per komponen disahkan | Pajak/biaya/laba salah; tidak ada toleransi uji resmi. |
| K5 | Makna/satuan Profit MUE, laba negatif, relasi laba AHS | Tetap dua hasil terpisah, tanpa profit sharing baru | Laba ganda atau margin dianggap pembagian profit tanpa bukti. |
| K6 | Kelayakan, perubahan harga/dokumen, dan peninjauan ulang keputusan tim | Perubahan memperbarui ranking/status dan memicu NEEDS_REVIEW; pilihan vendor tidak berganti otomatis | Penawaran usang/tidak lengkap dianggap memenuhi syarat atau keputusan dianggap final setelah berubah. |
| K7 | Membership/tipe biaya/alokasi per unit | Anggota eksplisit; total_cost/volume untuk biaya campuran setelah disahkan | Biaya terlewat/ganda, tetap dikali volume, biaya/unit salah. |
| K8 | Versi default/reset/pengesahan/simpan/retensi/restore | Default immutable, reset revisi baru, histori utuh | Default hilang, mapping diam-diam aktif kembali, hasil tak bisa direproduksi. |
| K9 | Batas scope SOP Procurement | Kelayakan vendor dan pemeriksaan dokumen tetap dilakukan tim di luar sistem; tidak ada checklist/scoring pada MVP | Aplikasi mengambil alih keputusan manusia atau scope berkembang tanpa permintaan |

**Status akhir:** dokumen ini menyelaraskan alur perhitungan/perbandingan harga → pemilihan penawaran manual oleh pengguna → Konversi Jagad → input HPP AHS manual oleh pengguna. Kelayakan vendor dan penerapan SOP berada di luar sistem. Parameter pajak, unit, biaya, presisi/step pencarian INU, serta histori masih harus ditentukan/dibuktikan sebelum hasil operasional final. Ini rancangan, bukan bukti aplikasi sudah diuji.
