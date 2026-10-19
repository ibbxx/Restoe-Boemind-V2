# Pratinjau loading logo 3D

Jalankan dari root repo:

```sh
python3 -m http.server 8769 --bind 127.0.0.1 --directory docs
```

Buka http://127.0.0.1:8769/previews/logo-loading.html. File HTML yang dibuka langsung mengarah ke alamat lokal tersebut.

Globe berputar dalam 12 detik, dua sapuan merah dalam 4 detik, dan sayap biru dalam 6 detik dengan arah berlawanan. Semua pose berasal dari satu clock; akhir siklus kembali ke pose awal. Jalur sayap memakai cangkang radial berbeda agar geometri tidak saling menembus.

Kontrol Jeda/Putar, Posisi, dan Logo asli hanya untuk peninjauan. Gerakan berhenti saat tab tersembunyi; preferensi reduced motion menjeda animasi saat awal. Masalah pemuatan atau konteks WebGL ditampilkan secara eksplisit.

Ini interpretasi 3D dari logo, bukan rekonstruksi PNG identik: peta lengkap menggantikan potongan Asia, dan jarak orbit disesuaikan untuk memisahkan sayap. Logo sumber di `docs/assets/logo.png` tetap utuh.

## Sumber dan lisensi

- Three.js **0.186.1**, disalin dari paket npm resmi; lisensi MIT di `vendor/THREE-LICENSE.txt`. Dokumentasi: https://threejs.org/docs/
- Tekstur `earth-map.png` dibuat dari Natural Earth 110m Land: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson. Data public domain: https://www.naturalearthdata.com/about/terms-of-use/
- `logo-wings.js` ditelusuri dari siluet merah dan biru pada logo sumber.

Seluruh dependensi dan tekstur tersedia lokal; pratinjau tidak memanggil CDN. Pratinjau memerlukan browser dengan WebGL 2.
