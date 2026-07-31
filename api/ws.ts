import http from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

import * as bus from '../lib/bus';
import { redisEnabled } from '../lib/redis';
import {
  listMembers,
  memberId,
  prunePresence,
  pushHistory,
  readHistory,
  roomChannel,
  touchPresence,
  dropPresence,
  type ChatMessage,
} from '../lib/rooms';

const PING_INTERVAL_MS = 30_000;
const PRESENCE_REFRESH_MS = 10_000;
const MAX_TEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 32;

type Client = {
  id: string;
  ws: WebSocket;
  user: string;
  room: string | null;
  alive: boolean;
};

/**
 * Tabel pengiriman LOKAL: hanya koneksi yang dipegang instance ini.
 * Ini bukan shared state — tiap instance memang cuma boleh mengirim ke socket
 * miliknya sendiri. State yang dibagi antar user (presence, history) ada di
 * Redis, lihat lib/rooms.ts.
 */
const clients = new Map<WebSocket, Client>();
const roomClients = new Map<string, Set<Client>>();
const roomHandlers = new Map<string, bus.Handler>();

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  // Request non-upgrade (mis. dibuka di browser) — dipakai buat cek cepat.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      endpoint: req.url,
      redis: redisEnabled,
      localConnections: clients.size,
      localRooms: [...roomClients.keys()],
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );
});

const wss = new WebSocketServer({ server });

function send(client: Client, payload: unknown): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(payload));
  }
}

/** Kirim ke koneksi room ini yang kebetulan ada di instance ini. */
function deliverLocal(room: string, payload: unknown): void {
  const set = roomClients.get(room);
  if (!set) return;
  for (const client of set) send(client, payload);
}

function sanitize(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

async function broadcastPresence(room: string): Promise<void> {
  await prunePresence(room);
  const members = await listMembers(room);
  await bus.publish(roomChannel(room), { type: 'presence', room, members });
}

async function joinRoom(client: Client, room: string, user: string): Promise<void> {
  if (client.room) await leaveRoom(client);

  client.room = room;
  client.user = user;

  let set = roomClients.get(room);
  if (!set) {
    set = new Set();
    roomClients.set(room, set);

    const handler: bus.Handler = (payload) => deliverLocal(room, payload);
    roomHandlers.set(room, handler);
    await bus.subscribe(roomChannel(room), handler);
  }
  set.add(client);

  await touchPresence(room, memberId(client.id, user));

  // State awal khusus untuk client ini. Dikirim ulang tiap kali dia join,
  // jadi reconnect otomatis dapat history + presence terbaru.
  send(client, { type: 'joined', room, user, connectionId: client.id });
  send(client, { type: 'history', room, messages: await readHistory(room) });

  await bus.publish(roomChannel(room), {
    type: 'system',
    room,
    text: `${user} bergabung`,
    ts: Date.now(),
  });
  await broadcastPresence(room);
}

async function leaveRoom(client: Client): Promise<void> {
  const room = client.room;
  if (!room) return;

  client.room = null;

  const set = roomClients.get(room);
  set?.delete(client);

  if (set && set.size === 0) {
    roomClients.delete(room);
    const handler = roomHandlers.get(room);
    if (handler) {
      roomHandlers.delete(room);
      await bus.unsubscribe(roomChannel(room), handler);
    }
  }

  await dropPresence(room, memberId(client.id, client.user));
  await bus.publish(roomChannel(room), {
    type: 'system',
    room,
    text: `${client.user} keluar`,
    ts: Date.now(),
  });
  await broadcastPresence(room);
}

async function handleChat(client: Client, raw: unknown): Promise<void> {
  if (!client.room) {
    send(client, { type: 'error', text: 'Join room dulu sebelum kirim pesan' });
    return;
  }

  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return;

  const message: ChatMessage = {
    id: randomUUID(),
    room: client.room,
    user: client.user,
    text: text.slice(0, MAX_TEXT_LENGTH),
    ts: Date.now(),
  };

  await pushHistory(message.room, message);
  // Tidak dikirim langsung ke socket lokal — biar semua instance (termasuk
  // instance ini) menerimanya lewat jalur yang sama dan urutannya konsisten.
  await bus.publish(roomChannel(message.room), { type: 'chat', ...message });
}

async function handleMessage(client: Client, data: unknown): Promise<void> {
  let payload: { type?: string; room?: unknown; user?: unknown; text?: unknown };
  try {
    payload = JSON.parse(String(data));
  } catch {
    send(client, { type: 'error', text: 'Pesan harus JSON' });
    return;
  }

  switch (payload.type) {
    case 'join':
      await joinRoom(
        client,
        sanitize(payload.room, 'general', MAX_NAME_LENGTH),
        sanitize(payload.user, `anon-${client.id.slice(0, 4)}`, MAX_NAME_LENGTH),
      );
      break;

    case 'chat':
      await handleChat(client, payload.text);
      break;

    case 'ping':
      send(client, { type: 'pong', ts: Date.now() });
      break;

    default:
      send(client, { type: 'error', text: `Tipe pesan tidak dikenal: ${payload.type}` });
  }
}

wss.on('connection', (ws) => {
  const client: Client = {
    id: randomUUID(),
    ws,
    user: 'anon',
    room: null,
    alive: true,
  };
  clients.set(ws, client);

  send(client, {
    type: 'welcome',
    connectionId: client.id,
    redis: redisEnabled,
    // Koneksi ditutup saat function kena max duration — client harus reconnect.
    maxDurationSeconds: 300,
  });

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (data) => {
    handleMessage(client, data).catch((err) => {
      console.error('[ws] gagal memproses pesan:', err);
      send(client, { type: 'error', text: 'Server gagal memproses pesan' });
    });
  });

  ws.on('close', () => {
    clients.delete(ws);
    leaveRoom(client).catch((err) => console.error('[ws] gagal cleanup:', err));
  });

  ws.on('error', (err) => console.error('[ws] socket error:', err));
});

// Buang koneksi yang sudah mati tapi belum mengirim close frame.
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, PING_INTERVAL_MS);

// Perpanjang presence koneksi lokal, sekaligus bersihkan sisa instance yang sudah mati.
setInterval(() => {
  void (async () => {
    for (const [room, set] of roomClients) {
      for (const client of set) {
        await touchPresence(room, memberId(client.id, client.user));
      }
      const removed = await prunePresence(room);
      if (removed > 0) await broadcastPresence(room);
    }
  })().catch((err) => console.error('[ws] presence refresh gagal:', err));
}, PRESENCE_REFRESH_MS);

if (!redisEnabled) {
  console.warn('[ws] REDIS_URL tidak diset — presence & history kosong, broadcast lokal saja.');
}

// Export instance http.Server, BUKAN handler function.
export default server;
