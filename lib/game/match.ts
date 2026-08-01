import { randomUUID } from 'crypto';

import * as bus from '../bus';
import { getClient, redisEnabled } from '../redis';
import { Arena, type ArenaEvents, type ArenaSnapshot, type Dir } from './arena';
import {
  CHANNELS,
  IDLE_RESET_TICKS,
  LEADER_REFRESH_MS,
  LEADER_TTL_MS,
  REDIS_KEYS,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
} from './constants';

/** Dipanggil untuk mengirim payload ke socket lokal. `to` null berarti semua. */
type Delivery = (payload: unknown, to: string | null) => void;

const REFRESH_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const instanceId = randomUUID();

let arena = new Arena();
let deliver: Delivery = () => {};
let isLeader = false;
let started = false;
let ticking = false;
let loopTimer: NodeJS.Timeout | null = null;
let emptyTicks = 0;
let rosterDirty = false;
let leaderboardDirty = false;

/** Pemain yang socketnya dipegang instance ini, beserta namanya. Bukan state bersama. */
const localPlayers = new Map<string, string>();

/** Pemain baru yang menunggu snapshot. Dikirim setelah mereka benar-benar lahir. */
const awaitingSnapshot = new Set<string>();

export function onDeliver(fn: Delivery): void {
  deliver = fn;
}

export function status() {
  return { instanceId, isLeader, localPlayers: localPlayers.size, tick: arena.tick };
}

// ---------------------------------------------------------------- sisi client

export function join(playerId: string, name: string): void {
  localPlayers.set(playerId, name);
  void publishIn({ k: 'join', id: playerId, name });
  // Jangan tunggu interval berikutnya. Kalau arena sedang tanpa leader, join di
  // atas akan hangus, dan handshake need-roster yang mengambilnya kembali.
  void manageLeadership().catch((err) => console.error('[match] leader:', err));
}

export function leave(playerId: string): void {
  localPlayers.delete(playerId);
  void publishIn({ k: 'leave', id: playerId });
}

export function setDir(playerId: string, dir: Dir): void {
  void publishIn({ k: 'dir', id: playerId, d: dir });
}

async function publishIn(msg: unknown): Promise<void> {
  try {
    await bus.publish(CHANNELS.in, msg);
  } catch (err) {
    console.error('[match] gagal kirim input:', err);
  }
}

async function publishOut(msg: unknown): Promise<void> {
  try {
    await bus.publish(CHANNELS.out, msg);
  } catch (err) {
    console.error('[match] gagal kirim state:', err);
  }
}

// ------------------------------------------------------------------- lifecycle

export function start(): void {
  if (started) return;
  started = true;

  void bus.subscribe(CHANNELS.in, handleInput);
  void bus.subscribe(CHANNELS.out, handleOutput);

  setInterval(() => {
    void manageLeadership().catch((err) => console.error('[match] leader:', err));
  }, LEADER_REFRESH_MS);
}

/**
 * Satu instance memegang kunci di Redis dan menjalankan simulasi. Kalau instance
 * itu kena max duration, kuncinya kedaluwarsa sendiri dan instance lain
 * mengambil alih dari snapshot terakhir.
 */
async function manageLeadership(): Promise<void> {
  if (!redisEnabled) {
    // Satu proses saja: tidak ada yang perlu direbut.
    if (!isLeader && localPlayers.size > 0) becomeLeader();
    return;
  }
  if (!isLeader && localPlayers.size === 0) return;

  const client = await getClient();

  if (isLeader) {
    const kept = await client.eval(REFRESH_LUA, {
      keys: [REDIS_KEYS.leader],
      arguments: [instanceId, String(LEADER_TTL_MS)],
    });
    if (kept === 0) stepDown();
    return;
  }

  const won = await client.set(REDIS_KEYS.leader, instanceId, { NX: true, PX: LEADER_TTL_MS });
  if (won !== 'OK') return;

  const raw = await client.get(REDIS_KEYS.snapshot);
  if (raw) {
    try {
      arena = Arena.fromSnapshot(JSON.parse(raw) as ArenaSnapshot);
    } catch (err) {
      console.error('[match] snapshot rusak, mulai arena baru:', err);
      arena = new Arena();
    }
  }
  becomeLeader();
}

function becomeLeader(): void {
  if (isLeader) return;
  isLeader = true;
  emptyTicks = 0;
  rosterDirty = true;
  console.log(`[match] instance ${instanceId.slice(0, 8)} jadi leader di tick ${arena.tick}`);
  // Instance lain (dan instance ini sendiri) mungkin memegang pemain yang belum
  // tercatat di snapshot, atau yang join-nya hangus saat arena belum punya leader.
  void publishOut({ k: 'need-roster' });
  loopTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void runTick()
      .catch((err) => console.error('[match] tick gagal:', err))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
}

function stepDown(): void {
  if (!isLeader) return;
  isLeader = false;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  console.log('[match] melepas peran leader');
}

async function releaseLeadership(): Promise<void> {
  stepDown();
  if (!redisEnabled) return;
  const client = await getClient();
  await client.eval(RELEASE_LUA, { keys: [REDIS_KEYS.leader], arguments: [instanceId] });
  await client.del(REDIS_KEYS.snapshot);
}

// ------------------------------------------------------------------ game loop

async function runTick(): Promise<void> {
  if (arena.playerCount === 0) {
    emptyTicks++;
    // Arena kosong: berhenti berdetak supaya tidak membakar kuota Redis.
    if (emptyTicks >= IDLE_RESET_TICKS) {
      arena = new Arena();
      await releaseLeadership();
    }
    return;
  }
  emptyTicks = 0;

  const events = arena.step();
  await publishOut({
    k: 'tick',
    tick: arena.tick,
    players: encodePlayers(),
    ev: compactEvents(events),
  });

  for (const id of awaitingSnapshot) {
    if (arena.players.has(id)) await publishOut({ k: 'snap', to: id, ...buildSnapshot() });
  }
  awaitingSnapshot.clear();

  if (events.deaths.length > 0) leaderboardDirty = true;
  if (events.rosterChanged || rosterDirty) {
    rosterDirty = false;
    await publishOut({ k: 'roster', players: arena.roster() });
  }

  if (arena.tick % SNAPSHOT_EVERY_TICKS === 0) await saveSnapshot();
  if (leaderboardDirty && arena.tick % SNAPSHOT_EVERY_TICKS === 0) {
    leaderboardDirty = false;
    await syncLeaderboard();
  }
}

function encodePlayers(): number[][] {
  const rows: number[][] = [];
  for (const p of arena.players.values()) {
    rows.push([
      p.slot,
      p.x,
      p.y,
      p.dir,
      p.alive && !p.frozen ? 1 : 0,
      arena.counts[p.slot],
      p.kills,
    ]);
  }
  return rows;
}

/** Buang bagian yang kosong supaya payload per tick tetap kecil. */
function compactEvents(events: ArenaEvents): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (events.captures.length) out.captures = events.captures;
  if (events.spawns.length) out.spawns = events.spawns;
  if (events.deaths.length) out.deaths = events.deaths;
  if (events.freed.length) out.freed = events.freed;
  if (events.clearTrails.length) out.clearTrails = events.clearTrails;
  return Object.keys(out).length > 0 ? out : undefined;
}

async function saveSnapshot(): Promise<void> {
  if (!redisEnabled) return;
  const client = await getClient();
  await client.set(REDIS_KEYS.snapshot, JSON.stringify(arena.snapshot()), { EX: 300 });
}

async function syncLeaderboard(): Promise<void> {
  const rows = arena
    .scoreboard()
    .map((row) => ({ name: row.name, cells: row.cells }))
    .filter((row) => row.cells > 0);

  if (redisEnabled && rows.length > 0) {
    const client = await getClient();
    for (const row of rows) {
      // GT: hanya naik, jadi yang tersimpan selalu rekor terbaik.
      await client.zAdd(REDIS_KEYS.leaderboard, { score: row.cells, value: row.name }, { GT: true });
    }
    await client.zRemRangeByRank(REDIS_KEYS.leaderboard, 0, -51);
  }
  await publishOut({ k: 'best', rows: await readLeaderboard() });
}

async function readLeaderboard(): Promise<{ name: string; cells: number }[]> {
  if (!redisEnabled) return [];
  const client = await getClient();
  const top = await client.zRangeWithScores(REDIS_KEYS.leaderboard, 0, 4, { REV: true });
  return top.map((entry) => ({ name: entry.value, cells: entry.score }));
}

// -------------------------------------------------------------- pesan internal

type InputMessage =
  | { k: 'join'; id: string; name: string }
  | { k: 'leave'; id: string }
  | { k: 'dir'; id: string; d: Dir };

function handleInput(msg: InputMessage): void {
  if (!isLeader) return;

  switch (msg.k) {
    case 'join': {
      const player = arena.join(msg.id, msg.name);
      if (!player) {
        void publishOut({ k: 'full', to: msg.id });
        return;
      }
      rosterDirty = true;
      // Snapshot ditunda sampai selesai satu tick. Pemain yang baru join belum
      // punya posisi, dan mengirimnya sekarang membuat kamera client mulai dari
      // pojok arena lalu melompat ke titik spawn.
      awaitingSnapshot.add(msg.id);
      return;
    }
    case 'leave':
      arena.disconnect(msg.id);
      rosterDirty = true;
      return;
    case 'dir':
      arena.setDir(msg.id, msg.d);
      return;
  }
}

function buildSnapshot() {
  const snap = arena.snapshot();
  return {
    tick: snap.tick,
    owner: snap.owner,
    players: snap.players.map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      x: p.x,
      y: p.y,
      dir: p.dir,
      alive: p.alive && !p.frozen,
      trail: p.trail,
      cells: arena.counts[p.slot],
    })),
  };
}

type OutputMessage = { k: string; to?: string } & Record<string, unknown>;

function handleOutput(msg: OutputMessage): void {
  if (msg.k === 'need-roster') {
    // Leader baru: daftarkan ulang pemain yang socketnya ada di instance ini.
    for (const [id, name] of localPlayers) void publishIn({ k: 'join', id, name });
    return;
  }
  deliver(msg, msg.to ?? null);
}
