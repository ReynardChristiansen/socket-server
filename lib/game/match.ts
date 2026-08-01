import { randomUUID } from 'crypto';

import * as bus from '../bus';
import { getClient, redisEnabled } from '../redis';
import { Arena, type ArenaEvents, type ArenaSnapshot, type Dir } from './arena';
import { decideBotMove, forgetBot } from './bot';
import {
  BOT_NAMES,
  CHANNELS,
  DESIRED_BOTS,
  IDLE_RESET_TICKS,
  LEADER_REFRESH_MS,
  LEADER_TTL_MS,
  MAX_PLAYERS,
  REDIS_KEYS,
  SNAPSHOT_EVERY_TICKS,
  TICK_MS,
} from './constants';

/** Sends a payload to local sockets. A null target means everyone. */
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

/** Players whose socket this instance holds, with their names. Not shared state. */
const localPlayers = new Map<string, string>();

/** New players waiting for a snapshot, sent once they have actually spawned. */
const awaitingSnapshot = new Set<string>();

export function onDeliver(fn: Delivery): void {
  deliver = fn;
}

export function status() {
  return { instanceId, isLeader, localPlayers: localPlayers.size, tick: arena.tick };
}

// ------------------------------------------------------------------ client side

export function join(playerId: string, name: string): void {
  localPlayers.set(playerId, name);
  void publishIn({ k: 'join', id: playerId, name });
  // Do not wait for the next interval. If the arena currently has no leader the
  // join above is dropped, and the need-roster handshake picks it back up.
  void manageLeadership().catch((err) => console.error('[match] leadership:', err));
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
    console.error('[match] failed to send input:', err);
  }
}

async function publishOut(msg: unknown): Promise<void> {
  try {
    await bus.publish(CHANNELS.out, msg);
  } catch (err) {
    console.error('[match] failed to send state:', err);
  }
}

// -------------------------------------------------------------------- lifecycle

export function start(): void {
  if (started) return;
  started = true;

  void bus.subscribe(CHANNELS.in, handleInput);
  void bus.subscribe(CHANNELS.out, handleOutput);

  setInterval(() => {
    void manageLeadership().catch((err) => console.error('[match] leadership:', err));
  }, LEADER_REFRESH_MS);
}

/**
 * One instance holds a lock in Redis and runs the simulation. If that instance
 * hits its max duration the lock expires on its own, another instance takes
 * over and resumes from the most recent snapshot.
 */
async function manageLeadership(): Promise<void> {
  if (!redisEnabled) {
    // Single process: there is nothing to contend for.
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
      console.error('[match] corrupt snapshot, starting a fresh arena:', err);
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
  console.log(`[match] instance ${instanceId.slice(0, 8)} became leader at tick ${arena.tick}`);
  // Other instances (and this one) may hold players that are missing from the
  // snapshot, or whose join was dropped while the arena had no leader.
  void publishOut({ k: 'need-roster' });
  loopTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void runTick()
      .catch((err) => console.error('[match] tick failed:', err))
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
  console.log('[match] released the leader role');
}

async function releaseLeadership(): Promise<void> {
  stepDown();
  if (!redisEnabled) return;
  const client = await getClient();
  await client.eval(RELEASE_LUA, { keys: [REDIS_KEYS.leader], arguments: [instanceId] });
  await client.del(REDIS_KEYS.snapshot);
}

// -------------------------------------------------------------------- game loop

async function runTick(): Promise<void> {
  if (arena.playerCount === 0) {
    emptyTicks++;
    // Empty arena: stop ticking so idle time does not burn Redis quota.
    if (emptyTicks >= IDLE_RESET_TICKS) {
      arena = new Arena();
      await releaseLeadership();
    }
    return;
  }
  emptyTicks = 0;

  const botChanges = syncBots();
  driveBots();

  const events = arena.step();
  if (botChanges.freed.length > 0) events.freed.push(...botChanges.freed);
  if (botChanges.clearTrails.length > 0) events.clearTrails.push(...botChanges.clearTrails);
  if (botChanges.rosterChanged) rosterDirty = true;

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

// -------------------------------------------------------------------------- bots

/**
 * Bots only exist to keep the arena from feeling empty, so they arrive when a
 * human does and leave with the last one. Keeping them around with nobody
 * watching would hold the tick loop open and burn quota forever.
 */
function syncBots(): { freed: number[]; clearTrails: number[]; rosterChanged: boolean } {
  const result = { freed: [] as number[], clearTrails: [] as number[], rosterChanged: false };
  const everyone = [...arena.players.values()];
  const humans = everyone.filter((p) => !p.isBot);
  const bots = everyone.filter((p) => p.isBot);

  const target = humans.length === 0 ? 0 : Math.min(DESIRED_BOTS, MAX_PLAYERS - humans.length);

  for (let i = bots.length; i > target; i--) {
    const victim = bots[i - 1];
    result.freed.push(...arena.remove(victim.id));
    result.clearTrails.push(victim.slot);
    forgetBot(victim.id);
    result.rosterChanged = true;
  }

  const taken = new Set(bots.map((bot) => bot.name));
  for (let i = bots.length; i < target; i++) {
    const name = BOT_NAMES.find((candidate) => !taken.has(candidate));
    if (!name) break;
    taken.add(name);
    if (arena.join(`bot:${name}`, name, true)) result.rosterChanged = true;
  }

  return result;
}

function driveBots(): void {
  for (const player of arena.players.values()) {
    if (!player.isBot || !player.alive || player.frozen) continue;
    arena.setDir(player.id, decideBotMove(arena, player));
  }
}

// ------------------------------------------------------------------ serialising

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

/** Drop empty sections so the per-tick payload stays small. */
function compactEvents(events: ArenaEvents): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (events.captures.length) out.captures = events.captures;
  if (events.spawns.length) out.spawns = events.spawns;
  if (events.deaths.length) out.deaths = events.deaths;
  if (events.freed.length) out.freed = events.freed;
  if (events.clearTrails.length) out.clearTrails = events.clearTrails;
  return Object.keys(out).length > 0 ? out : undefined;
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
      bot: p.isBot,
      x: p.x,
      y: p.y,
      dir: p.dir,
      alive: p.alive && !p.frozen,
      trail: p.trail,
      cells: arena.counts[p.slot],
    })),
  };
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
      // GT keeps the stored value as the player's personal best.
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

// -------------------------------------------------------------- internal messages

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
      // The snapshot waits one tick. A player who just joined has no position
      // yet, and sending it now makes the client camera start in the corner of
      // the arena and then jump to the spawn point.
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

type OutputMessage = { k: string; to?: string } & Record<string, unknown>;

function handleOutput(msg: OutputMessage): void {
  if (msg.k === 'need-roster') {
    // Fresh leader: re-register the players whose sockets live on this instance.
    for (const [id, name] of localPlayers) void publishIn({ k: 'join', id, name });
    return;
  }
  deliver(msg, msg.to ?? null);
}
