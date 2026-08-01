# Territory

Game rebut wilayah multiplayer realtime — ala paper.io — dengan server otoritatif
10 tick per detik yang jalan di Vercel Functions.

Keluar dari wilayahmu, lingkari tanah kosong, lalu pulang untuk merebutnya. Kalau ada
yang menyentuh jejakmu sebelum kamu sampai rumah, kamu kehilangan semuanya.

## Kenapa ini tidak sesederhana kelihatannya

Vercel Functions bukan server yang hidup selamanya. Tiga batasannya bertabrakan
langsung dengan kebutuhan sebuah game realtime, dan itu yang membentuk arsitektur di sini:

**Koneksi baru bisa mendarat di instance mana pun.** Dua pemain di arena yang sama belum
tentu dilayani proses yang sama, jadi tidak ada satu pun proses yang otomatis memegang
kebenaran tentang isi arena.

**Function mati saat mencapai max duration, 300 detik.** Simulasi tidak boleh ikut mati
bersamanya.

**Koneksi pemain ikut putus saat itu terjadi.** Jadi putus koneksi bukan kasus langka
yang boleh diabaikan — itu kejadian rutin tiap lima menit.

## Cara kerjanya

Satu instance memegang kunci di Redis dan menjadi **leader**. Hanya dia yang menjalankan
simulasi. Instance lain tidak ikut menghitung apa pun — mereka cuma meneruskan input
pemainnya ke leader, lalu menyiarkan hasil yang datang balik ke socket miliknya sendiri.

```
pemain ─► instance A ─┐                        ┌─► instance A ─► pemain
                      ├─► arena:in ─► LEADER ──┤
pemain ─► instance B ─┘                simulasi└─► instance B ─► pemain
                                       10 Hz         arena:out
```

Kunci leader berumur 3 detik dan diperpanjang tiap detik. Kalau instance pemegangnya kena
max duration, kuncinya kedaluwarsa sendiri, instance lain mengambil alih, memuat snapshot
terakhir dari Redis, lalu meneruskan pertandingan. Pemain merasakan tersendat sekitar satu
detik, bukan kehilangan arena.

Saat leader baru terpilih, dia menyiarkan `need-roster`. Setiap instance menjawab dengan
mendaftarkan ulang pemain yang socketnya dia pegang — ini yang menutup celah pemain yang
join tepat saat arena sedang tanpa leader.

**Putus koneksi tidak langsung menghapus pemain.** Wilayahnya ditahan 12 detik. Karena
client menyimpan id-nya di `localStorage` dan mengirimnya lagi saat reconnect, pemain yang
koneksinya diputus oleh max duration akan kembali ke wilayah yang sama. Dari sisi pemain,
game-nya tidak terasa terputus.

**Arena kosong berhenti berdetak.** Tidak ada pemain berarti tidak ada tick, tidak ada
command Redis, dan kunci leader dilepas. Kuota tidak terbakar saat tidak ada yang main.

## Apa yang dikirim tiap tick

Grid 100×100 itu 10.000 sel. Mengirim seluruhnya 10 kali per detik akan menghabiskan
puluhan megabit per menit, jadi yang disiarkan cuma yang berubah:

| Isi | Kapan dikirim |
|---|---|
| Posisi, arah, skor semua pemain | tiap tick (~12 baris angka) |
| Sel yang baru direbut | hanya saat ada yang merebut |
| Sel yang jadi netral | hanya saat ada yang mati |
| Grid penuh (RLE) | sekali, saat pemain masuk atau reconnect |

Jejak tidak dikirim sama sekali. Client menyusunnya sendiri: kalau posisi pemain berada di
sel yang bukan miliknya, itu jejak. Server cukup memberi tahu kapan jejak harus dihapus.

## Struktur

```
lib/game/arena.ts       simulasi murni — gerak, tabrakan, rebut wilayah. Tanpa jaringan.
lib/game/match.ts       pemilihan leader, game loop, snapshot, papan rekor
lib/game/constants.ts   ukuran arena, tick rate, warna, kunci Redis
lib/bus.ts              pub/sub antar instance lewat Redis
lib/redis.ts            koneksi command dan koneksi subscriber terpisah
api/ws.ts               WebSocket server — export instance http.Server
public/                 client: canvas, HUD, kontrol sentuh
test/arena.test.ts      15 tes untuk aturan permainan
```

`arena.ts` sengaja tidak tahu apa-apa soal jaringan maupun Redis. Semua aturan permainan
bisa diuji tanpa menyalakan server:

```bash
npm test
```

## Aturan permainan

- Petak awal 5×5, menghadap sisi arena yang paling lapang
- Di luar wilayah sendiri, pemain meninggalkan jejak
- Kembali ke wilayah sendiri → jejak jadi milikmu, dan **semua yang terkurung ikut direbut**
- Menyentuh jejak seseorang membunuh **pemilik jejaknya**, bukan yang menyentuh
- Menabrak jejak sendiri, tepi arena, atau bertabrakan kepala-lawan-kepala juga mematikan
- Yang mati kehilangan seluruh wilayahnya dan lahir kembali 3 detik kemudian
- Balik badan 180° hanya dilarang saat sedang menyeret jejak

Perebutan wilayah dihitung terbalik: banjiri arena dari tepi, apa pun yang tidak tersentuh
berarti terkurung. Satu kali flood fill untuk seluruh grid, sekitar 0,1 ms.

## Kontrol

Papan ketik `WASD` atau tombol panah. Di layar sentuh, geser di mana saja — joystick muncul
di titik sentuh.

## Jalan lokal

```bash
npm install
npm test

npm i -g vercel
vercel link
vercel dev            # http://localhost:3000
```

Redis lokal opsional untuk dev satu proses. Tanpa `REDIS_URL`, arena tetap jalan di satu
proses tanpa pemilihan leader dan tanpa papan rekor.

```bash
docker run -d -p 6379:6379 --name territory-redis redis
# REDIS_URL=redis://localhost:6379 di .env.local
```

## Deploy

1. **Fluid compute harus aktif** (Settings → Functions). Tanpa ini WebSocket tidak jalan.
2. Tambahkan Redis dari Vercel Marketplace, connect ke project. Kode membaca `REDIS_URL`
   atau `KV_URL`.
3. Taruh Redis di region yang sama dengan function. Simulasi menyentuh Redis 10 kali per
   detik; kalau keduanya beda benua, game-nya terasa berat.
4. `vercel --prod`

Cek cepat: `curl https://<domain>/api/ws` — akan menampilkan `redis`, jumlah koneksi
lokal, dan siapa leader-nya.

## Konsumsi kuota

Sekitar 40.000 command Redis per jam saat arena ramai, jadi free tier Upstash (500.000
command per bulan) cukup untuk kira-kira 12 jam pertandingan. Arena kosong tidak memakan
apa pun. Kalau perlu lebih hemat, turunkan tick rate di `lib/game/constants.ts` atau
perjarang snapshot.

## Catatan teknis

`tsconfig.json` memakai `module: Node16`. Setelan gaya bundler (`ESNext` +
`moduleResolution: Bundler`) membuat seluruh function gagal dimuat di Vercel dengan
`FUNCTION_INVOCATION_FAILED`, karena hasil kompilasinya keluar sebagai ESM sementara
runtime memuatnya sebagai CommonJS.
