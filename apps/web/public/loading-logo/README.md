# Aset loading 2.5D

`logo.png` adalah salinan logo sumber `docs/assets/logo.png`, tanpa mengubah sumbernya.

`earth.webp` adalah tekstur 512×256 yang diperkecil dari `docs/previews/earth-map.png`, dibuat dari [Natural Earth 110m Land](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson). Data Natural Earth berada dalam [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

Geometri sayap pada `src/ui/loading-logo-shapes.json` berasal dari siluet logo dan disiapkan saat pembuatan aset. Renderer aplikasi memakai Canvas 2D bawaan browser; Three.js hanya dipakai sebagai alat penyiapan geometri dan bukan dependency aplikasi.
