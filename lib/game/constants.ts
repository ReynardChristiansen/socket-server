/** Arena size in cells. Every layer addresses cells by flat index y * GRID_W + x. */
export const GRID_W = 100;
export const GRID_H = 100;
export const GRID_SIZE = GRID_W * GRID_H;

/**
 * Ten simulation steps per second. Lowering this to 66ms makes turning feel
 * noticeably snappier but costs 1.5x the Redis commands, so it trades quota for
 * responsiveness. The client smooths motion between steps either way.
 */
export const TICK_MS = 100;

export const MAX_PLAYERS = 12;

/** Starting block, odd-sided so the player sits exactly in the middle. */
export const SPAWN_SIZE = 5;

export const RESPAWN_TICKS = 30;

/**
 * Vercel closes connections every 300 seconds. A missing player keeps their
 * territory for this long so reconnecting feels seamless instead of fatal.
 */
export const DISCONNECT_GRACE_TICKS = 120;

/** Leader lease. If the holding instance dies, the lock expires on its own. */
export const LEADER_TTL_MS = 3000;
export const LEADER_REFRESH_MS = 1000;

/** Snapshot cadence, so a replacement leader can resume mid-match. */
export const SNAPSHOT_EVERY_TICKS = 20;

/** An empty arena stops ticking after this, so idle time costs no quota. */
export const IDLE_RESET_TICKS = 100;

export const MAX_NAME_LENGTH = 14;

/** Bots only exist while at least one human is playing. */
export const DESIRED_BOTS = 3;

export const BOT_NAMES = [
  'Nova',
  'Echo',
  'Vega',
  'Onyx',
  'Kite',
  'Juno',
  'Rune',
  'Sable',
] as const;

/** Player colours, picked to stay distinguishable from each other on dark. */
export const COLORS = [
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#84cc16',
  '#06b6d4',
  '#f59e0b',
] as const;

export const REDIS_KEYS = {
  leader: 'arena:leader',
  snapshot: 'arena:snapshot',
  leaderboard: 'arena:leaderboard',
} as const;

export const CHANNELS = {
  in: 'arena:in',
  out: 'arena:out',
} as const;
