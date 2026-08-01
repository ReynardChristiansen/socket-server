import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Arena } from '../lib/game/arena';
import { decideBotMove, forgetBot } from '../lib/game/bot';

/** Runs the same loop the leader runs: decide, then step. */
function play(arena: Arena, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const player of arena.players.values()) {
      if (!player.alive || player.frozen) continue;
      arena.setDir(player.id, decideBotMove(arena, player));
    }
    arena.step();
  }
}

function seatBot(arena: Arena, id: string, x: number, y: number) {
  const bot = arena.join(id, id, true);
  assert.ok(bot);
  arena.spawnAt(id, x, y);
  return bot;
}

test('a lone bot survives a full minute and claims ground', () => {
  const arena = new Arena();
  const bot = seatBot(arena, 'bot-solo', 50, 50);

  play(arena, 600);

  assert.equal(bot.deaths, 0, 'a bot on its own should never kill itself');
  assert.equal(bot.alive, true);
  assert.ok(
    arena.counts[bot.slot] > 25,
    `expected the bot to expand past its 25 starting cells, got ${arena.counts[bot.slot]}`,
  );
  forgetBot(bot.id);
});

test('a bot cornered against the walls never drives off the board', () => {
  for (const [x, y] of [
    [96, 50],
    [3, 3],
    [50, 96],
    [96, 96],
  ]) {
    const arena = new Arena();
    const id = `bot-corner-${x}-${y}`;
    const bot = seatBot(arena, id, x, y);

    play(arena, 400);

    assert.equal(bot.deaths, 0, `bot spawned at ${x},${y} hit something`);
    assert.ok(bot.x >= 0 && bot.x < 100 && bot.y >= 0 && bot.y < 100);
    forgetBot(id);
  }
});

test('a bot never crosses its own trail', () => {
  const arena = new Arena();
  const bot = seatBot(arena, 'bot-trail', 30, 30);

  for (let i = 0; i < 800; i++) {
    arena.setDir(bot.id, decideBotMove(arena, bot));
    arena.step();
    // Every death here is self-inflicted: nobody else is in the arena.
    assert.equal(bot.deaths, 0, `bot died on tick ${i}`);
  }
  forgetBot(bot.id);
});

test('several bots share an arena and keep claiming ground', () => {
  const arena = new Arena();
  const bots = [
    seatBot(arena, 'bot-a', 20, 20),
    seatBot(arena, 'bot-b', 75, 25),
    seatBot(arena, 'bot-c', 25, 75),
    seatBot(arena, 'bot-d', 78, 78),
  ];

  play(arena, 600);

  const claimed = bots.reduce((sum, bot) => sum + arena.counts[bot.slot], 0);
  assert.ok(
    claimed > 4 * 25,
    `four bots should hold more than their starting blocks, got ${claimed}`,
  );
  for (const bot of bots) forgetBot(bot.id);
});
