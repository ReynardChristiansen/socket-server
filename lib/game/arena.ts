import {
  DISCONNECT_GRACE_TICKS,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  MAX_PLAYERS,
  RESPAWN_TICKS,
  SPAWN_SIZE,
} from './constants';

export type Dir = 0 | 1 | 2 | 3;

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

const isOpposite = (a: Dir, b: Dir): boolean => (a + 2) % 4 === b;

export type Player = {
  id: string;
  name: string;
  slot: number;
  x: number;
  y: number;
  dir: Dir;
  queuedDir: Dir | null;
  alive: boolean;
  /** Sedang di luar wilayah sendiri, artinya sedang meninggalkan jejak. */
  trailing: boolean;
  /** Koneksi putus tapi wilayahnya masih ditahan. Tidak ikut bergerak. */
  frozen: boolean;
  goneTick: number | null;
  respawnTick: number;
  kills: number;
  deaths: number;
  best: number;
};

export type ArenaEvents = {
  captures: { slot: number; cells: number[] }[];
  spawns: { slot: number; cells: number[] }[];
  deaths: { slot: number; killer: number | null }[];
  /** Sel yang kembali netral, entah karena pemiliknya mati atau keluar. */
  freed: number[];
  /** Slot yang jejaknya harus dihapus di sisi client. */
  clearTrails: number[];
  rosterChanged: boolean;
};

export type PlayerSnapshot = Omit<Player, 'queuedDir'> & { trail: number[] };

export type ArenaSnapshot = {
  tick: number;
  /** Grid pemilik dalam bentuk run-length encoding: [nilai, jumlah, ...]. */
  owner: number[];
  players: PlayerSnapshot[];
};

function emptyEvents(): ArenaEvents {
  return {
    captures: [],
    spawns: [],
    deaths: [],
    freed: [],
    clearTrails: [],
    rosterChanged: false,
  };
}

export function rleEncode(grid: Int8Array): number[] {
  const out: number[] = [];
  let value = grid[0];
  let run = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    if (grid[i] === value) {
      run++;
    } else {
      out.push(value, run);
      value = grid[i];
      run = 1;
    }
  }
  out.push(value, run);
  return out;
}

export function rleDecode(data: number[], out: Int8Array): void {
  let i = 0;
  for (let k = 0; k < data.length; k += 2) {
    const value = data[k];
    const run = data[k + 1];
    out.fill(value, i, i + run);
    i += run;
  }
}

/**
 * Simulasi murni, tanpa jaringan dan tanpa Redis. Semua aturan permainan ada di
 * sini supaya bisa diuji sendiri tanpa menyalakan server.
 */
export class Arena {
  tick = 0;
  readonly owner = new Int8Array(GRID_SIZE).fill(-1);
  readonly trail = new Int8Array(GRID_SIZE).fill(-1);
  readonly counts = new Int32Array(MAX_PLAYERS);
  readonly players = new Map<string, Player>();

  private readonly bySlot: (Player | null)[] = new Array(MAX_PLAYERS).fill(null);
  private readonly trailCells: number[][] = Array.from({ length: MAX_PLAYERS }, () => []);
  private readonly floodSeen = new Uint8Array(GRID_SIZE);
  private readonly floodStack = new Int32Array(GRID_SIZE);

  get playerCount(): number {
    return this.players.size;
  }

  getTrail(slot: number): readonly number[] {
    return this.trailCells[slot];
  }

  join(id: string, name: string): Player | null {
    const existing = this.players.get(id);
    if (existing) {
      // Reconnect: lanjutkan dari kondisi terakhir, wilayahnya tidak hilang.
      existing.frozen = false;
      existing.goneTick = null;
      if (name) existing.name = name;
      return existing;
    }

    const slot = this.bySlot.indexOf(null);
    if (slot === -1) return null;

    const player: Player = {
      id,
      name,
      slot,
      x: 0,
      y: 0,
      dir: 1,
      queuedDir: null,
      alive: false,
      trailing: false,
      frozen: false,
      goneTick: null,
      respawnTick: this.tick,
      kills: 0,
      deaths: 0,
      best: 0,
    };
    this.players.set(id, player);
    this.bySlot[slot] = player;
    return player;
  }

  /** Koneksi putus. Pemain dibekukan dulu, belum dibuang. */
  disconnect(id: string): void {
    const player = this.players.get(id);
    if (!player || player.goneTick !== null) return;
    player.frozen = true;
    player.goneTick = this.tick;
    player.trailing = false;
    this.clearTrail(player.slot);
  }

  remove(id: string): number[] {
    const player = this.players.get(id);
    if (!player) return [];
    this.clearTrail(player.slot);
    const freed = this.freeTerritory(player.slot);
    this.players.delete(id);
    this.bySlot[player.slot] = null;
    return freed;
  }

  setDir(id: string, dir: Dir): void {
    const player = this.players.get(id);
    if (!player || !player.alive || player.frozen) return;
    if (player.dir === dir) return;
    player.queuedDir = dir;
  }

  step(): ArenaEvents {
    this.tick++;
    const events = emptyEvents();

    this.expireDisconnected(events);
    this.respawnWaiting(events);

    const moving: Player[] = [];
    const nextIdx = new Map<number, number>();
    const dying = new Map<number, number | null>();

    for (const player of this.players.values()) {
      if (!player.alive || player.frozen) continue;
      moving.push(player);

      if (player.queuedDir !== null) {
        const wanted = player.queuedDir;
        player.queuedDir = null;
        // Balik badan hanya dilarang saat sedang menyeret jejak, karena sel di
        // belakang adalah jejak sendiri dan itu berarti mati seketika. Di dalam
        // wilayah sendiri tidak ada jejak, jadi bebas ke arah mana pun.
        if (!(isOpposite(player.dir, wanted) && player.trailing)) player.dir = wanted;
      }

      const nx = player.x + DX[player.dir];
      const ny = player.y + DY[player.dir];
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) {
        dying.set(player.slot, null);
        continue;
      }
      nextIdx.set(player.slot, ny * GRID_W + nx);
    }

    // Dua pemain menuju sel yang sama: dua-duanya mati, tidak ada yang diuntungkan.
    const occupants = new Map<number, number[]>();
    for (const [slot, idx] of nextIdx) {
      const list = occupants.get(idx);
      if (list) list.push(slot);
      else occupants.set(idx, [slot]);
    }
    for (const [, slots] of occupants) {
      if (slots.length > 1) for (const slot of slots) dying.set(slot, null);
    }

    // Menabrak jejak: yang mati pemilik jejaknya, bukan yang menabrak.
    for (const [slot, idx] of nextIdx) {
      if (dying.has(slot)) continue;
      const victim = this.trail[idx];
      if (victim >= 0) dying.set(victim, victim === slot ? null : slot);
    }

    for (const [slot, killer] of dying) {
      const player = this.bySlot[slot];
      if (!player || !player.alive) continue;
      if (killer !== null) {
        const hunter = this.bySlot[killer];
        if (hunter) hunter.kills++;
      }
      events.freed.push(...this.killPlayer(player));
      events.deaths.push({ slot, killer });
      events.clearTrails.push(slot);
    }

    for (const player of moving) {
      if (dying.has(player.slot)) continue;
      const idx = nextIdx.get(player.slot);
      if (idx === undefined) continue;

      player.x = idx % GRID_W;
      player.y = (idx / GRID_W) | 0;

      if (this.owner[idx] === player.slot) {
        if (player.trailing) {
          const cells = this.capture(player);
          events.captures.push({ slot: player.slot, cells });
          events.clearTrails.push(player.slot);
        }
        player.trailing = false;
      } else {
        this.trail[idx] = player.slot;
        this.trailCells[player.slot].push(idx);
        player.trailing = true;
      }

      if (this.counts[player.slot] > player.best) player.best = this.counts[player.slot];
    }

    return events;
  }

  private expireDisconnected(events: ArenaEvents): void {
    for (const player of [...this.players.values()]) {
      if (player.goneTick === null) continue;
      if (this.tick - player.goneTick < DISCONNECT_GRACE_TICKS) continue;
      events.freed.push(...this.remove(player.id));
      events.clearTrails.push(player.slot);
      events.rosterChanged = true;
    }
  }

  private respawnWaiting(events: ArenaEvents): void {
    for (const player of this.players.values()) {
      if (player.alive || player.frozen) continue;
      if (this.tick < player.respawnTick) continue;
      const cells = this.spawn(player);
      if (cells.length > 0) events.spawns.push({ slot: player.slot, cells });
    }
  }

  /** Penempatan eksplisit. Dipakai tes supaya tidak bergantung pada spawn acak. */
  spawnAt(id: string, cx: number, cy: number): number[] {
    const player = this.players.get(id);
    if (!player) return [];
    return this.placeAt(player, cx, cy, (SPAWN_SIZE - 1) / 2);
  }

  private spawn(player: Player): number[] {
    const half = (SPAWN_SIZE - 1) / 2;
    const margin = half + 1;

    for (let attempt = 0; attempt < 400; attempt++) {
      const cx = margin + Math.floor(Math.random() * (GRID_W - margin * 2));
      const cy = margin + Math.floor(Math.random() * (GRID_H - margin * 2));
      if (!this.areaIsFree(cx, cy, half)) continue;
      return this.placeAt(player, cx, cy, half);
    }
    // Arena padat: tetap tempatkan, ambil alih sel yang ada.
    const cx = margin + Math.floor(Math.random() * (GRID_W - margin * 2));
    const cy = margin + Math.floor(Math.random() * (GRID_H - margin * 2));
    return this.placeAt(player, cx, cy, half);
  }

  private areaIsFree(cx: number, cy: number, half: number): boolean {
    for (let y = cy - half; y <= cy + half; y++) {
      for (let x = cx - half; x <= cx + half; x++) {
        const idx = y * GRID_W + x;
        if (this.owner[idx] !== -1 || this.trail[idx] !== -1) return false;
      }
    }
    return true;
  }

  private placeAt(player: Player, cx: number, cy: number, half: number): number[] {
    const cells: number[] = [];
    for (let y = cy - half; y <= cy + half; y++) {
      for (let x = cx - half; x <= cx + half; x++) {
        const idx = y * GRID_W + x;
        if (this.trail[idx] >= 0) this.dropTrailCell(this.trail[idx], idx);
        this.setOwner(idx, player.slot);
        cells.push(idx);
      }
    }
    player.x = cx;
    player.y = cy;
    player.alive = true;
    player.trailing = false;
    player.queuedDir = null;
    // Menghadap ke sisi paling lapang. Kalau selalu menghadap kanan, pemain yang
    // lahir dekat tepi kanan langsung melaju ke dinding sebelum sempat berbelok.
    const room = [cy, GRID_W - 1 - cx, GRID_H - 1 - cy, cx];
    player.dir = room.indexOf(Math.max(...room)) as Dir;
    return cells;
  }

  private killPlayer(player: Player): number[] {
    player.alive = false;
    player.trailing = false;
    player.queuedDir = null;
    player.deaths++;
    player.respawnTick = this.tick + RESPAWN_TICKS;
    this.clearTrail(player.slot);
    return this.freeTerritory(player.slot);
  }

  private clearTrail(slot: number): void {
    for (const idx of this.trailCells[slot]) {
      if (this.trail[idx] === slot) this.trail[idx] = -1;
    }
    this.trailCells[slot].length = 0;
  }

  private dropTrailCell(slot: number, idx: number): void {
    this.trail[idx] = -1;
    const cells = this.trailCells[slot];
    const at = cells.indexOf(idx);
    if (at >= 0) cells.splice(at, 1);
  }

  private freeTerritory(slot: number): number[] {
    const freed: number[] = [];
    if (this.counts[slot] === 0) return freed;
    for (let i = 0; i < GRID_SIZE; i++) {
      if (this.owner[i] === slot) {
        this.owner[i] = -1;
        freed.push(i);
      }
    }
    this.counts[slot] = 0;
    return freed;
  }

  private setOwner(idx: number, slot: number): void {
    const prev = this.owner[idx];
    if (prev === slot) return;
    if (prev >= 0) this.counts[prev]--;
    this.owner[idx] = slot;
    this.counts[slot]++;
  }

  /**
   * Pemain kembali ke wilayahnya. Jejak jadi miliknya, lalu semua sel yang
   * terkurung ikut direbut. Caranya dibalik: banjiri dari tepi arena, apa pun
   * yang tidak tersentuh berarti terkurung.
   */
  private capture(player: Player): number[] {
    const slot = player.slot;
    const gained: number[] = [];

    for (const idx of this.trailCells[slot]) {
      if (this.trail[idx] === slot) this.trail[idx] = -1;
      if (this.owner[idx] !== slot) {
        this.setOwner(idx, slot);
        gained.push(idx);
      }
    }
    this.trailCells[slot].length = 0;

    const seen = this.floodSeen;
    const stack = this.floodStack;
    seen.fill(0);
    let top = 0;

    const pushIfOpen = (idx: number): void => {
      if (seen[idx] || this.owner[idx] === slot) return;
      seen[idx] = 1;
      stack[top++] = idx;
    };

    for (let x = 0; x < GRID_W; x++) {
      pushIfOpen(x);
      pushIfOpen((GRID_H - 1) * GRID_W + x);
    }
    for (let y = 0; y < GRID_H; y++) {
      pushIfOpen(y * GRID_W);
      pushIfOpen(y * GRID_W + GRID_W - 1);
    }

    while (top > 0) {
      const idx = stack[--top];
      const x = idx % GRID_W;
      const y = (idx / GRID_W) | 0;
      if (x > 0) pushIfOpen(idx - 1);
      if (x < GRID_W - 1) pushIfOpen(idx + 1);
      if (y > 0) pushIfOpen(idx - GRID_W);
      if (y < GRID_H - 1) pushIfOpen(idx + GRID_W);
    }

    for (let i = 0; i < GRID_SIZE; i++) {
      if (!seen[i] && this.owner[i] !== slot) {
        this.setOwner(i, slot);
        gained.push(i);
      }
    }
    return gained;
  }

  roster(): { id: string; slot: number; name: string }[] {
    return [...this.players.values()].map((p) => ({ id: p.id, slot: p.slot, name: p.name }));
  }

  scoreboard(): { slot: number; name: string; cells: number; kills: number; alive: boolean }[] {
    return [...this.players.values()]
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        cells: this.counts[p.slot],
        kills: p.kills,
        alive: p.alive && !p.frozen,
      }))
      .sort((a, b) => b.cells - a.cells);
  }

  snapshot(): ArenaSnapshot {
    return {
      tick: this.tick,
      owner: rleEncode(this.owner),
      players: [...this.players.values()].map(({ queuedDir: _drop, ...rest }) => ({
        ...rest,
        trail: [...this.trailCells[rest.slot]],
      })),
    };
  }

  static fromSnapshot(data: ArenaSnapshot): Arena {
    const arena = new Arena();
    arena.tick = data.tick;
    rleDecode(data.owner, arena.owner);

    for (let i = 0; i < GRID_SIZE; i++) {
      const slot = arena.owner[i];
      if (slot >= 0) arena.counts[slot]++;
    }

    for (const snap of data.players) {
      const { trail, ...rest } = snap;
      const player: Player = { ...rest, queuedDir: null };
      arena.players.set(player.id, player);
      arena.bySlot[player.slot] = player;
      for (const idx of trail) {
        arena.trail[idx] = player.slot;
        arena.trailCells[player.slot].push(idx);
      }
    }
    return arena;
  }
}
