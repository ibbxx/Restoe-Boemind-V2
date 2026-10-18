# Formula engine — Fase 3

Scope mengikuti prompt pengguna: parser/evaluator/graph. Penomoran ini berbeda dari
roadmap PRD §14 (engine disebut Phase 2 di sana). Tidak ada perubahan roadmap sumber.

## Kontrak penggunaan

`new FormulaEngine(configuration)` menangkap konfigurasi immutable. Wajib ada versi
konfigurasi, policy UUID, `scale` 0–36, `rounding` DOWN/HALF_UP/HALF_EVEN dan
`roundAt: EVERY_OPERATION`. Literal, input dan setiap operasi dibulatkan pada skala
tersebut. BigInt menyimpan koefisien fixed-scale, bukan floating point. DOWN berarti
truncate ke nol; HALF_EVEN memecahkan tie ke digit genap. Tidak ada default uang,
format tampilan, clamp negatif, tarif, faktor konversi atau solver.

`evaluate(snapshot)` membuat unsaved preview. `evaluateRevision(savedRevision)`
mengikat run ke snapshot dan revision yang diberikan oleh pemanggil tepercaya.
`recalculate(snapshot, previous)` atau `evaluateRevision(revision, previous)` memakai
graph lama/baru untuk menghitung descendant perubahan saja. Perubahan decimal/policy
atau previous run yang tidak diterbitkan engine memakai full recalculation.
Versi membership/unit yang berubah hanya menginvalidasi target/dependent terkait.

`publish(run, authoritativeHead)` menolak run dari revision/snapshot/configuration
berbeda, termasuk objek run tiruan. Pemanggil wajib mengambil head dari repository
saat publikasi. `latest(analysisId, profile)` menyimpan pointer preview in-memory;
publikasi stale tidak menggantinya. `getRun`/`runHistory` mempertahankan payload run
historis dalam instance yang sama. Tidak ada asynchronous scheduler atau database.

Run merekam snapshot lengkap (input, selection, formula/override/provenance, mapping,
profil dan policy ref), konfigurasi lengkap (unit/membership/numeric policy), engine
version, revision ID, hasil/status per node dan signature. Manifest dapat diserialisasi
dengan JSON dan dievaluasi ulang memakai konfigurasi historis. Hasil lama immutable.
Cache incremental hanya mempercayai run immutable yang diterbitkan engine dalam proses.

## Grammar dan resolver

Literal desimal memakai titik; operator `+ - * /`, unary sign, kurung, postfix `%`,
dan `SUM(expr,...)`. `11%` berarti pembagian 100 sesuai policy eksplisit. SUM tidak
mengabaikan EMPTY/error/teks. Direct text reference tetap teks.

- `@{UUID-v4}` menunjuk cell stable ID.
- `#{UUID-v4}` menunjuk aggregate terdaftar berisi `versionId` dan daftar member cell ID.
- `referenceCellIds` formula harus sama dengan dependency AST setelah ekspansi membership.
- Runtime menolak A1/range, leading `=`, unknown function, exponent, property access,
  JavaScript dan token lain. Adapter fixture test menerjemahkan alamat workbook sebelum parser.
- Batas teknis: 16.384 karakter, 2.048 token, nesting 128, graph 10.000 node,
  koefisien decimal maksimal 256 karakter. Kelebihan batas menghasilkan error eksplisit.

Graph memeriksa single writer, existence, scope, cycle/SCC, lalu mengevaluasi dependency
sebelum consumer. Error memuat code, cell ID dan path; cabang independen tetap dievaluasi.
Status VALUE, ZERO, TEXT, EMPTY, MISSING, INVALID dan ERROR berbeda. ZERO adalah hasil
numerik nol eksplisit (padanan ZERO_EXPLICIT PRD), bukan bukti kelayakan bisnis.

## Unit, mapping dan freshness

Konfigurasi unit berisi symbol eksplisit dan dimension exponents untuk setiap node
numerik. `{}` berarti dimensionless; metadata yang hilang berarti UNCONFIGURED_UNIT.
Penjumlahan/pengurangan/SUM memerlukan dimensi sama; perkalian/pembagian menggabungkan
dimensi. Hasil diperiksa terhadap unit target. Tidak ada liter↔kg atau konversi label.
ACTIVE mapping harus cocok dengan symbol source/target dan belum mendukung konversi
berbeda label; faktor bisnis baru tidak disimpulkan dari label atau formula sumber.

Cell `MAPPING` memilih mapping ID sebagai writer. INPUT tetap manual walaupun UNSET;
mapping aktif yang juga menulis INPUT/FORMULA menghasilkan WRITER_CONFLICT. HPP AHS
mengikuti Biaya Konversi pada profilnya dan domain menolak mapping langsung ke HPP. Formula source/override, mapping, input dan
calculated result memiliki tempat terpisah. Tidak ada prioritas writer implisit.

`selectionDependentCellIds` menyatakan node yang secara eksplisit bergantung pada
pilihan offer; ini tidak menyalin nilai atau mengganti pilihan. Offer revision terbaru
yang belum dipilih tidak mengubah signature dependency tersebut.

`assessFreshness(run, snapshot)` memakai graph lama/baru dan membatasi dampak ke profil
run beserta dependency SHARED yang benar-benar dipakai. `reviewRun` mencatat input
graph ke ReviewContext yang ada; `refreshReviewContexts` menerapkan STALE/NEEDS_REVIEW
untuk konteks terkait. Domain command/Save juga mengikuti declared writer aktif
transitif. Bila konfigurasi unit/membership eksternal berubah, pemanggil wajib
memanggil assessment engine karena metadata itu tidak berada dalam schema snapshot v2.

## Finalitas dan keputusan tersisa

Run sukses aritmetika tetap NONFINAL dengan BUSINESS_VALIDATION_REQUIRED. Preview
tidak menjadi CONFIRMED. Repository tetap menolak CONFIRM_RESULT: policy finalisasi
bisnis, mapping/units operasional dan fixture uang belum disahkan. Mengubah label
ACTIVE atau CONFIGURED bukan pengesahan otomatis. Error di profil lain tetap ada
pada results, tetapi status run mengikuti profil aktif dan dependency-nya.

Profit MUE hanya operasional INU, target Rp50 dan interval `[50,51)` tetap acuan;
tidak ada pencarian Biaya atau solver sebelum step/batas/presisi/rounding disahkan.

Tes baseline membaca hash workbook, shared formulas dan 166 formula/358 dependency
audit v0.3 dari `BUNDLE_BASELINE_FORMULA_AUDIT_v0.3/`. Oracle itu bersifat struktural;
cached/independent evaluation bukan expected value resmi. EV-005 tetap TODO dengan
konflik 22860 versus 25170 yang tidak diubah. Test baseline memakai utilitas sistem
`unzip` secara read-only; tidak ada dependency baru.
