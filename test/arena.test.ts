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
  assert.ok(player, `a slot should be free for ${id}`);
  arena.spawnAt(id, x, y);
  return player;
}

test('spawning gives a 5x5 block with the player in the middle', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  assert.equal(player.alive, true);
  assert.equal(player.x, 50);
  assert.equal(player.y, 50);
  assert.equal(arena.counts[player.slot], 25);
  assert.equal(arena.owner[at(48, 48)], player.slot);
  assert.equal(arena.owner[at(53, 50)], -1);
});

test('leaving home draws a trail, returning claims everything it enclosed', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 1, 5); // right, to (55,50)
  assert.equal(player.trailing, true, 'should be drawing a trail outside home');
  assert.ok(arena.getTrail(player.slot).length > 0);

  drive(arena, 'p1', 2, 3); // down, to (55,53)
  drive(arena, 'p1', 3, 5); // left, to (50,53)
  drive(arena, 'p1', 0, 1); // up, back onto own land

  assert.equal(player.trailing, false, 'the trail is consumed on arrival');
  assert.equal(arena.getTrail(player.slot).length, 0);
  assert.equal(arena.owner[at(54, 51)], player.slot, 'enclosed cells change hands');
  assert.equal(arena.owner[at(55, 50)], player.slot, 'the old trail becomes land');
  assert.ok(arena.counts[player.slot] > 25, 'territory should grow past 25');
});

test('touching a trail kills its owner, not whoever touched it', () => {
  const arena = new Arena();
  const hunted = seat(arena, 'p1', 20, 20);
  drive(arena, 'p1', 1, 6); // p1 lays a trail along y=20

  const hunter = seat(arena, 'p2', 26, 24);
  drive(arena, 'p2', 0, 4); // walks up through p1's trail at (26,20)

  assert.equal(hunted.alive, false, 'the trail owner dies');
  assert.equal(hunter.alive, true, 'whoever touched it survives');
  assert.equal(hunter.kills, 1);
  assert.equal(arena.counts[hunted.slot], 0, 'a dead player releases their land');
});

test('running into your own trail is fatal', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 0, 8); // up to (50,42), trail along x=50
  drive(arena, 'p1', 1, 3); // right to (53,42)
  drive(arena, 'p1', 2, 3); // down to (53,45)
  drive(arena, 'p1', 3, 3); // left, crossing its own trail at (50,45)

  assert.equal(player.alive, false);
  assert.equal(player.deaths, 1);
  assert.equal(player.kills, 0, 'suicide is not a kill');
});

test('hitting the edge of the arena is fatal', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 2, 50);

  drive(arena, 'p1', 3, 3); // x goes 1, 0, then off the board

  assert.equal(player.alive, false);
  assert.equal(arena.counts[player.slot], 0);
});

test('two players entering the same cell both die', () => {
  const arena = new Arena();
  const a = seat(arena, 'p1', 20, 50);
  const b = seat(arena, 'p2', 30, 50);

  arena.setDir('p1', 1);
  arena.setDir('p2', 3);
  for (let i = 0; i < 5; i++) arena.step();

  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.kills, 0, 'a head-on collision is nobody-s kill');
  assert.equal(b.kills, 0);
});

test('inside your own land you may reverse straight away', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50); // spawns facing the roomiest side

  arena.setDir('p1', 3);
  arena.step();

  assert.equal(player.dir, 3, 'a fresh spawn must be able to go any direction');
  assert.equal(player.x, 49);
});

test('reversing is ignored while dragging a trail', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);

  drive(arena, 'p1', 1, 5); // out to (55,50), trail behind
  assert.equal(player.trailing, true);

  arena.setDir('p1', 3);
  arena.step();

  assert.equal(player.dir, 1, 'must not turn back onto its own trail');
  assert.equal(player.x, 56);
  assert.equal(player.alive, true);
});

test('a dropped connection holds the land, then releases it after the grace period', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);
  const slot = player.slot;

  arena.disconnect('p1');
  arena.step();
  assert.equal(arena.counts[slot], 25, 'land survives the grace period');
  assert.equal(arena.players.size, 1);

  for (let i = 0; i < DISCONNECT_GRACE_TICKS + 1; i++) arena.step();

  assert.equal(arena.players.size, 0, 'the player is dropped once grace runs out');
  assert.equal(arena.counts[slot], 0);
});

test('reconnecting with the same id resumes the old territory', () => {
  const arena = new Arena();
  const before = seat(arena, 'p1', 50, 50);
  arena.disconnect('p1');
  arena.step();

  const after = arena.join('p1', 'p1');

  assert.equal(after?.slot, before.slot);
  assert.equal(after?.frozen, false);
  assert.equal(arena.counts[before.slot], 25);
});

test('the arena turns away a thirteenth player', () => {
  const arena = new Arena();
  for (let i = 0; i < 12; i++) assert.ok(arena.join(`p${i}`, `p${i}`));
  assert.equal(arena.join('p12', 'p12'), null);
});

test('run-length encoding round trips the grid unchanged', () => {
  const arena = new Arena();
  seat(arena, 'p1', 30, 30);
  seat(arena, 'p2', 70, 70);

  const restored = new Int8Array(GRID_SIZE);
  rleDecode(rleEncode(arena.owner), restored);

  assert.deepEqual([...restored], [...arena.owner]);
});

test('a snapshot restores land, trails and positions', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 50, 50);
  drive(arena, 'p1', 1, 5); // leave a trail behind

  const restored = Arena.fromSnapshot(JSON.parse(JSON.stringify(arena.snapshot())));
  const copy = restored.players.get('p1');

  assert.ok(copy);
  assert.equal(restored.tick, arena.tick);
  assert.equal(copy.x, player.x);
  assert.equal(copy.y, player.y);
  assert.equal(restored.counts[player.slot], arena.counts[player.slot]);
  assert.deepEqual([...restored.getTrail(player.slot)], [...arena.getTrail(player.slot)]);

  // Play must continue from a snapshot, capture included.
  drive(restored, 'p1', 2, 3);
  drive(restored, 'p1', 3, 5);
  drive(restored, 'p1', 0, 1);
  assert.ok(restored.counts[player.slot] > 25);
});

test('spawns face the roomiest side rather than always facing right', () => {
  const arena = new Arena();

  const right = seat(arena, 'p1', 95, 50); // hard against the right wall
  assert.equal(right.dir, 3, 'should face left, away from the wall');

  const left = seat(arena, 'p2', 4, 50);
  assert.equal(left.dir, 1, 'should face right');

  const top = seat(arena, 'p3', 50, 4);
  assert.equal(top.dir, 2, 'should face down');
});

test('a player spawned at the edge survives long enough to turn', () => {
  const arena = new Arena();
  const player = seat(arena, 'p1', 96, 50);

  for (let i = 0; i < 30; i++) arena.step();

  assert.equal(player.alive, true, 'needs room for the first three seconds');
});
