import http from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { redisEnabled } from '../lib/redis';
import * as match from '../lib/game/match';
import type { Dir } from '../lib/game/arena';
import {
  COLORS,
  GRID_H,
  GRID_W,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  TICK_MS,
} from '../lib/game/constants';

const PING_INTERVAL_MS = 30_000;
/** Batas belok per detik. Menahan client nakal membakar kuota Redis. */
const MAX_TURNS_PER_SECOND = 15;

type Client = {
  ws: WebSocket;
  playerId: string | null;
  alive: boolean;
  lastDir: Dir | null;
  turnWindowStart: number;
  turnsInWindow: number;
};

/**
 * Socket yang dipegang instance ini saja. Simulasi dan skor tidak ada di sini —
 * itu milik leader dan Redis, lihat lib/game/match.ts.
 */
const clients = new Map<WebSocket, Client>();
const byPlayerId = new Map<string, Client>();

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      endpoint: req.url,
      redis: redisEnabled,
      localConnections: clients.size,
      match: match.status(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );
});

const wss = new WebSocketServer({ server });

function send(client: Client, payload: unknown): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

match.onDeliver((payload, to) => {
  if (to === null) {
    for (const client of clients.values()) if (client.playerId) send(client, payload);
    return;
  }
  const target = byPlayerId.get(to);
  if (target) send(target, payload);
});

function cleanName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) return `Pemain-${Math.floor(Math.random() * 900 + 100)}`;
  return text.slice(0, MAX_NAME_LENGTH);
}

/** Id dipakai ulang saat reconnect supaya wilayah pemain tidak hilang. */
function cleanPlayerId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(value) ? value : randomUUID();
}

function handleJoin(client: Client, payload: Record<string, unknown>): void {
  if (client.playerId) return;

  const playerId = cleanPlayerId(payload.id);
  const existing = byPlayerId.get(playerId);
  if (existing && existing !== client) {
    send(client, { k: 'err', msg: 'Id pemain ini sedang dipakai koneksi lain' });
    client.ws.close();
    return;
  }

  client.playerId = playerId;
  byPlayerId.set(playerId, client);

  send(client, {
    k: 'welcome',
    id: playerId,
    grid: { w: GRID_W, h: GRID_H },
    tickMs: TICK_MS,
    colors: COLORS,
    maxPlayers: MAX_PLAYERS,
  });
  match.join(playerId, cleanName(payload.name));
}

function handleDir(client: Client, payload: Record<string, unknown>): void {
  if (!client.playerId) return;

  const dir = payload.d;
  if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return;
  if (dir === client.lastDir) return;

  const now = Date.now();
  if (now - client.turnWindowStart >= 1000) {
    client.turnWindowStart = now;
    client.turnsInWindow = 0;
  }
  if (client.turnsInWindow >= MAX_TURNS_PER_SECOND) return;
  client.turnsInWindow++;

  client.lastDir = dir;
  match.setDir(client.playerId, dir);
}

function handleMessage(client: Client, data: unknown): void {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(data));
  } catch {
    return;
  }

  switch (payload.k) {
    case 'join':
      handleJoin(client, payload);
      return;
    case 'dir':
      handleDir(client, payload);
      return;
    case 'ping':
      send(client, { k: 'pong', ts: Date.now() });
      return;
  }
}

wss.on('connection', (ws) => {
  const client: Client = {
    ws,
    playerId: null,
    alive: true,
    lastDir: null,
    turnWindowStart: 0,
    turnsInWindow: 0,
  };
  clients.set(ws, client);

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (data) => handleMessage(client, data));

  ws.on('close', () => {
    clients.delete(ws);
    if (client.playerId && byPlayerId.get(client.playerId) === client) {
      byPlayerId.delete(client.playerId);
      match.leave(client.playerId);
    }
  });

  ws.on('error', (err) => console.error('[ws] socket error:', err));
});

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

match.start();

if (!redisEnabled) {
  console.warn('[ws] REDIS_URL tidak diset — arena hanya hidup di satu proses.');
}

// Export instance http.Server, BUKAN handler function.
export default server;
