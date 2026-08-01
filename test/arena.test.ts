import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Arena, rleDecode, rleEncode, type Dir } from '../lib/game/arena';
import { DISCONNECT_GRACE_TICKS, GRID_SIZE, GRID_W } from '../lib/game/constants';

const at = (x: number, y: number): number => y * GRID_W + x;

function drive(arena: Arena, id: string, dir: Dir, steps: number): void {
  arena.setDir(id, dir);
  for (let i = 0; i < steps; i++) arena.step();
}

function seat(arena: Arena, id: string, x: number, y: number) {
  const player = arena.join(id, id);
  assert.ok(player, `slot untuk ${id} harus tersedia`);
  arena.spawnAt(id, x, y);
  return player;
}

test('spawn memberi petak 5x5 dan pemain hidup di tengahnya', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  assert.equal(player.alive, true);
  assert.equal(player.x, 50);
  assert.equal(player.y, 50);
  assert.equal(arena.counts[player.slot], 25);
  assert.equal(arena.owner[at(48, 48)], player.slot);
  assert.equal(arena.owner[at(53, 50)], -1);
});

test('keluar wilayah meninggalkan jejak, kembali merebut area yang terkurung', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 1, 5); // ke kanan sampai (55,50)
  assert.equal(player.trailing, true, 'harus meninggalkan jejak di luar wilayah');
  assert.ok(arena.getTrail(player.slot).length > 0);

  drive(arena, 'p1', 2, 3); // turun ke (55,53)
  drive(arena, 'p1', 3, 5); // ke kiri sampai (50,53)
  drive(arena, 'p1', 0, 1); // naik ke (50,52), masuk wilayah sendiri lagi

  assert.equal(player.trailing, false, 'jejak harus habis setelah kembali');
  assert.equal(arena.getTrail(player.slot).length, 0);
  assert.equal(arena.owner[at(54, 51)], player.slot, 'sel terkurung harus jadi milik pemain');
  assert.equal(arena.owner[at(55, 50)], player.slot, 'bekas jejak harus jadi milik pemain');
  assert.ok(arena.counts[player.slot] > 25, 'wilayah harus bertambah dari 25');
});

test('menabrak jejak lawan membunuh pemilik jejaknya, bukan penabraknya', () => {
  const arena = new Arena();
  const hunted = seat(arena, 'p1', 20, 20);
  drive(arena, 'p1', 1, 6); // jejak p1 terbentang di y=20

  const hunter = seat(arena, 'p2', 26, 24);
  drive(arena, 'p2', 0, 4); // naik menembus jejak p1 di (26,20)

  assert.equal(hunted.alive, false, 'pemilik jejak yang mati');
  assert.equal(hunter.alive, true, 'penabrak selamat');
  assert.equal(hunter.kills, 1);
  assert.equal(arena.counts[hunted.slot], 0, 'wilayah yang mati harus dibebaskan');
});

test('menabrak jejak sendiri berarti mati sendiri', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 0, 8); // naik jauh sampai (50,42), jejak sepanjang x=50
  drive(arena, 'p1', 1, 3); // ke kanan  (53,42)
  drive(arena, 'p1', 2, 3); // turun     (53,45)
  drive(arena, 'p1', 3, 3); // ke kiri, memotong jejaknya sendiri di (50,45)

  assert.equal(player.alive, false);
  assert.equal(player.deaths, 1);
  assert.equal(player.kills, 0, 'bunuh diri tidak dihitung kill');
});

test('menabrak tepi arena mematikan', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 2, 50);

  drive(arena, 'p1', 3, 3); // x: 1, 0, lalu -1

  assert.equal(player.alive, false);
  assert.equal(arena.counts[player.slot], 0);
});

test('dua pemain menuju sel yang sama, dua-duanya mati', () => {
  const arena = new Arena();
  const a = seat(arena, 'p1', 20, 50);
  const b = seat(arena, 'p2', 30, 50);

  arena.setDir('p1', 1);
  arena.setDir('p2', 3);
  for (let i = 0; i < 5; i++) arena.step();

  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.kills, 0, 'tabrakan kepala tidak dihitung sebagai kill');
  assert.equal(b.kills, 0);
});

test('di dalam wilayah sendiri boleh langsung balik arah', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50); // spawn menghadap ruang terlapang

  arena.setDir('p1', 3);
  arena.step();

  assert.equal(player.dir, 3, 'pemain baru spawn harus bisa ke segala arah');
  assert.equal(player.x, 49);
});

test('balik badan diabaikan saat sedang menyeret jejak', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 1, 5); // sampai (55,50), sedang menyeret jejak
  assert.equal(player.trailing, true);

  arena.setDir('p1', 3);
  arena.step();

  assert.equal(player.dir, 1, 'arah tidak boleh berbalik ke jejak sendiri');
  assert.equal(player.x, 56);
  assert.equal(player.alive, true);
});

test('pemain yang putus koneksi menahan wilayahnya, lalu dilepas setelah masa tenggang', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);
  const slot = player.slot;

  arena.disconnect('p1');
  arena.step();
  assert.equal(arena.counts[slot], 25, 'wilayah harus bertahan selama masa tenggang');
  assert.equal(arena.players.size, 1);

  for (let i = 0; i < DISCONNECT_GRACE_TICKS + 1; i++) arena.step();

  assert.equal(arena.players.size, 0, 'pemain dibuang setelah masa tenggang habis');
  assert.equal(arena.counts[slot], 0);
});

test('reconnect memakai id yang sama melanjutkan wilayah yang lama', () => {
  const arena = new Arena();
  const before = seat(arena, 'p1', 50, 50);
  arena.disconnect('p1');
  arena.step();

  const after = arena.join('p1', 'p1');

  assert.equal(after?.slot, before.slot);
  assert.equal(after?.frozen, false);
  assert.equal(arena.counts[before.slot], 25);
});

test('arena menolak pemain ke-13', () => {
  const arena = new Arena();
  for (let i = 0; i < 12; i++) assert.ok(arena.join(`p${i}`, `p${i}`));
  assert.equal(arena.join('p12', 'p12'), null);
});

test('run-length encoding bolak-balik menghasilkan grid yang sama', () => {
  const arena = new Arena();
  seat(arena, 'p1', 30, 30);
  seat(arena, 'p2', 70, 70);

  const restored = new Int8Array(GRID_SIZE);
  rleDecode(rleEncode(arena.owner), restored);

  assert.deepEqual([...restored], [...arena.owner]);
});

test('snapshot memulihkan wilayah, jejak, dan posisi', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);
  drive(arena, 'p1', 1, 5); // tinggalkan jejak

  const restored = Arena.fromSnapshot(JSON.parse(JSON.stringify(arena.snapshot())));
  const copy = restored.players.get('p1');

  assert.ok(copy);
  assert.equal(restored.tick, arena.tick);
  assert.equal(copy.x, player.x);
  assert.equal(copy.y, player.y);
  assert.equal(restored.counts[player.slot], arena.counts[player.slot]);
  assert.deepEqual([...restored.getTrail(player.slot)], [...arena.getTrail(player.slot)]);

  // Lanjut bermain dari snapshot harus tetap bisa merebut wilayah.
  drive(restored, 'p1', 2, 3);
  drive(restored, 'p1', 3, 5);
  drive(restored, 'p1', 0, 1);
  assert.ok(restored.counts[player.slot] > 25);
});

test('spawn menghadap sisi paling lapang, bukan selalu ke kanan', () => {
  const arena = new Arena();

  const kanan = seat(arena, 'p1', 95, 50); // mepet tepi kanan
  assert.equal(kanan.dir, 3, 'harus menghadap kiri, menjauhi dinding');

  const kiri = seat(arena, 'p2', 4, 50); // mepet tepi kiri
  assert.equal(kiri.dir, 1, 'harus menghadap kanan');

  const atas = seat(arena, 'p3', 50, 4); // mepet tepi atas
  assert.equal(atas.dir, 2, 'harus menghadap bawah');
});

test('pemain di tepi tidak mati sendiri sebelum sempat berbelok', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 96, 50);

  for (let i = 0; i < 30; i++) arena.step();

  assert.equal(player.alive, true, 'harus punya cukup ruang untuk 3 detik pertama');
});
