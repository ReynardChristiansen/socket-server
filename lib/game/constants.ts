/** Ukuran arena dalam sel. Semua sisi kode memakai indeks datar y * GRID_W + x. */
export const GRID_W = 100;
export const GRID_H = 100;
export const GRID_SIZE = GRID_W * GRID_H;

/** 10 tick per detik. Client menginterpolasi di antaranya supaya terlihat halus. */
export const TICK_MS = 100;

export const MAX_PLAYERS = 12;

/** Petak awal saat spawn, sisi ganjil supaya pemain pas di tengah. */
export const SPAWN_SIZE = 5;

export const RESPAWN_TICKS = 30;

/**
 * Koneksi di Vercel putus tiap 300 detik. Pemain yang hilang tidak langsung
 * dibuang — wilayahnya ditahan selama ini supaya reconnect terasa mulus.
 */
export const DISCONNECT_GRACE_TICKS = 120;

/** Umur kunci leader. Kalau instance pemegangnya mati, kunci lepas sendiri. */
export const LEADER_TTL_MS = 3000;
export const LEADER_REFRESH_MS = 1000;

/** Simpan snapshot tiap 2 detik supaya leader pengganti bisa melanjutkan. */
export const SNAPSHOT_EVERY_TICKS = 20;

/** Arena dibersihkan kalau kosong selama ini, supaya tidak makan kuota Redis. */
export const IDLE_RESET_TICKS = 100;

export const MAX_NAME_LENGTH = 14;

/** Warna pemain. Dipilih kontras satu sama lain dan tetap terbaca di latar gelap. */
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
