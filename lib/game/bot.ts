import { Arena, DX, DY, isOpposite, type Dir, type Player } from './arena';
import { GRID_H, GRID_W } from './constants';

/** How far ahead a direction is probed before it is considered safe. */
const LOOKAHEAD = 6;
/** Below this much clear run, a direction is only used as a last resort. */
const COMFORTABLE_RUN = 2;

type BotPlan = {
  /** Cells to travel before turning, which sets the size of the loop it carves. */
  leg: number;
  stepsOnLeg: number;
  homeX: number;
  homeY: number;
};

const plans = new Map<string, BotPlan>();

export function forgetBot(id: string): void {
  plans.delete(id);
}

/**
 * Counts how many cells a direction stays survivable, up to LOOKAHEAD.
 * Zero means moving there kills the bot on the very next step.
 *
 * Only the bot's own trail is fatal — running over someone else's trail kills
 * them instead, so it is treated as free ground.
 */
function clearRun(arena: Arena, bot: Player, dir: Dir): number {
  if (isOpposite(bot.dir, dir) && bot.trailing) return 0;

  let x = bot.x;
  let y = bot.y;
  for (let step = 1; step <= LOOKAHEAD; step++) {
    x += DX[dir];
    y += DY[dir];
    if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return step - 1;
    if (arena.trail[y * GRID_W + x] === bot.slot) return step - 1;
  }
  return LOOKAHEAD;
}

/** Directions that shorten the distance back to where the bot left home. */
function towardHome(bot: Player, plan: BotPlan): Dir[] {
  const dx = plan.homeX - bot.x;
  const dy = plan.homeY - bot.y;
  const horizontal: Dir[] = dx === 0 ? [] : [dx > 0 ? 1 : 3];
  const vertical: Dir[] = dy === 0 ? [] : [dy > 0 ? 2 : 0];
  return Math.abs(dx) >= Math.abs(dy)
    ? [...horizontal, ...vertical]
    : [...vertical, ...horizontal];
}

/**
 * Picks a direction for one bot.
 *
 * The strategy is deliberately plain: carve a rectangle by turning the same way
 * every few cells, head home once the trail gets long, and never take a step
 * that walks into a wall or its own trail. That is enough to claim territory
 * steadily without ever killing itself.
 */
export function decideBotMove(arena: Arena, bot: Player): Dir {
  let plan = plans.get(bot.id);
  if (!plan) {
    plan = { leg: 5, stepsOnLeg: 0, homeX: bot.x, homeY: bot.y };
    plans.set(bot.id, plan);
  }

  if (!bot.trailing) {
    // Safe at home: remember this spot and start a fresh loop.
    plan.homeX = bot.x;
    plan.homeY = bot.y;
    plan.stepsOnLeg = 0;
    plan.leg = 4 + Math.floor(Math.random() * 5);
  } else {
    plan.stepsOnLeg++;
  }

  const trailLength = arena.getTrail(bot.slot).length;
  const shouldHeadHome = trailLength >= plan.leg * 3;
  const shouldTurn = bot.trailing && plan.stepsOnLeg >= plan.leg;

  const preferences: Dir[] = [];
  if (shouldHeadHome) preferences.push(...towardHome(bot, plan));
  if (shouldTurn) preferences.push(((bot.dir + 1) % 4) as Dir);
  preferences.push(bot.dir, ((bot.dir + 1) % 4) as Dir, ((bot.dir + 3) % 4) as Dir);

  let fallback: Dir = bot.dir;
  let fallbackRun = -1;

  for (const dir of preferences) {
    const run = clearRun(arena, bot, dir);
    if (run >= COMFORTABLE_RUN) {
      if (dir !== bot.dir) plan.stepsOnLeg = 0;
      return dir;
    }
    if (run > fallbackRun) {
      fallbackRun = run;
      fallback = dir;
    }
  }

  // Everything preferred is cramped, so take whichever direction survives longest.
  for (const dir of [0, 1, 2, 3] as Dir[]) {
    const run = clearRun(arena, bot, dir);
    if (run > fallbackRun) {
      fallbackRun = run;
      fallback = dir;
    }
  }
  if (fallback !== bot.dir) plan.stepsOnLeg = 0;
  return fallback;
}
