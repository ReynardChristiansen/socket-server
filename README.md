# socket-project

Chat server WebSocket di Vercel Functions. Pakai `ws` + Redis pub/sub.

## Struktur

```
api/ws.ts           WebSocket server — export instance http.Server
lib/redis.ts        koneksi Redis (client untuk command/publish + subscriber terpisah)
lib/bus.ts          pub/sub antar instance, satu-satunya jalur broadcast
lib/rooms.ts        presence & message history di Redis
public/index.html   client chat: origin-relative URL + reconnect exponential backoff
vercel.json         maxDuration 300 detik
```

## Protokol

Client → server:

```jsonc
{ "type": "join", "room": "general", "user": "rey" }
{ "type": "chat", "text": "halo" }
{ "type": "ping" }
```

Server → client:

```jsonc
{ "type": "welcome", "connectionId": "...", "redis": true, "maxDurationSeconds": 300 }
{ "type": "joined", "room": "general", "user": "rey", "connectionId": "..." }
{ "type": "history", "room": "general", "messages": [ /* 50 pesan terakhir */ ] }
{ "type": "chat", "id": "...", "room": "general", "user": "rey", "text": "halo", "ts": 0 }
{ "type": "presence", "room": "general", "members": ["rey", "budi"] }
{ "type": "system", "room": "general", "text": "budi bergabung", "ts": 0 }
{ "type": "error", "text": "..." }
```

`join` sekaligus berfungsi sebagai resubscribe + reload state, jadi client cukup
mengirim ulang `join` setiap kali reconnect.

## Jalan lokal

```bash
npm install
cp .env.example .env.local        # isi REDIS_URL

npm i -g vercel
vercel link
vercel dev                        # http://localhost:3000
```

Redis lokal (opsional tapi disarankan, tanpa ini presence & history kosong):

```bash
docker run -d -p 6379:6379 --name socket-redis redis
# REDIS_URL=redis://localhost:6379 di .env.local
```

Cek cepat dari terminal:

```bash
curl http://localhost:3000/api/ws          # health check, lihat "redis": true
npx wscat -c ws://localhost:3000/api/ws
> {"type":"join","room":"general","user":"rey"}
> {"type":"chat","text":"halo"}
```

## Deploy

1. **Fluid compute harus aktif** (Settings → Functions). Tanpa ini WebSocket tidak jalan.
   Default untuk project yang dibuat sejak 23 April 2025.
2. Tambahkan Redis lewat Vercel Marketplace (Storage → Redis), connect ke project ini.
   Pastikan env var-nya bernama `REDIS_URL`.
3. Deploy:

```bash
vercel              # preview
vercel --prod       # production
```

4. Tes di preview deployment, bukan cuma localhost:

```bash
npx wscat -c wss://<preview-url>/api/ws
```

Debug: `vercel logs <deployment-url> --follow`

## Yang perlu diingat

- Koneksi putus tiap 300 detik karena max duration. Itu normal — client sudah punya
  reconnect + exponential backoff (1s → 30s). Naikkan `maxDuration` di `vercel.json`
  kalau perlu (maks 800 detik di Pro/Enterprise).
- Semua broadcast lewat Redis pub/sub. `roomClients` di `api/ws.ts` cuma tabel
  pengiriman lokal per instance, bukan shared state.
- Presence pakai sorted set + timestamp, di-refresh tiap 10 detik dan entri yang lebih
  tua dari 30 detik dibuang. Jadi koneksi yang mati mendadak (instance kena max duration
  atau deployment diganti) tidak meninggalkan user hantu di daftar online.
- Tanpa `REDIS_URL` server tetap jalan untuk dev satu proses, tapi presence dan history
  kosong dan broadcast tidak menyeberang antar instance. Server mencetak warning saat start
  dan `redis: false` muncul di health check.

## Kalau ternyata cuma butuh satu arah

Kalau fiturnya cuma server → client (notifikasi, progress bar, streaming AI), SSE lebih
sederhana dan lebih cocok daripada WebSocket. Lihat bagian "Catatan" di `CLAUDE.md`.
