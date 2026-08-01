# Territory

A realtime multiplayer land grab game — paper.io style — with an authoritative
server running ten simulation steps per second on Vercel Functions.

Leave your land, loop around open ground, then make it home to claim it. If
anyone touches your trail before you get back, you lose everything.

## Why this is harder than it looks

Vercel Functions are not long-lived servers. Three of their properties collide
head-on with what a realtime game needs, and they shaped the whole design:

**New connections can land on any instance.** Two players in the same arena are
not necessarily served by the same process, so no process automatically owns the
truth about the game.

**A function is killed at its max duration, 300 seconds.** The simulation cannot
die with it.

**Player connections drop at that moment too.** Disconnects are not a rare edge
case here — they happen to everyone, every five minutes.

## How it works

One instance holds a lock in Redis and becomes the **leader**. Only it runs the
simulation. Other instances compute nothing: they forward their players' input
to the leader and broadcast whatever comes back to their own sockets.

```
player ─► instance A ─┐                        ┌─► instance A ─► player
                      ├─► arena:in ─► LEADER ──┤
player ─► instance B ─┘                 10 Hz  └─► instance B ─► player
                                    simulation      arena:out
```

The leader lock lives for three seconds and is renewed every second. When the
holding instance hits its max duration the lock expires by itself, another
instance takes over, loads the last snapshot from Redis and carries on. Players
feel about a second of stutter rather than losing the arena.

A fresh leader broadcasts `need-roster`. Every instance answers by re-registering
the players whose sockets it holds, which closes the gap for anyone who joined
while the arena had no leader at all.

**A dropped connection does not remove a player.** Their land is held for twelve
seconds. The client keeps its id in `localStorage` and sends it again on
reconnect, so a player cut off by the max duration comes back to the same
territory. From their side the game never broke.

**An empty arena stops ticking.** No players means no steps, no Redis commands
and no leader lock. Idle time costs nothing.

## What goes over the wire each tick

A 100×100 grid is 10,000 cells. Sending all of it ten times a second would burn
tens of megabits a minute, so only changes are broadcast:

| Payload | Sent when |
|---|---|
| Every player's position, direction and score | every tick (~12 rows of numbers) |
| Newly claimed cells | only when someone captures |
| Cells returned to neutral | only when someone dies |
| The full grid, run-length encoded | once, on join or reconnect |

Trails are never sent. The client derives them: if a player stands on a cell they
do not own, that cell is trail. The server only has to say when a trail is gone.

## Rendering

Ten steps per second is choppy if drawn literally, and two details fix that:

- Heads ease toward the authoritative cell with a 45ms time constant rather than
  being interpolated across a whole tick. That halves the visual delay behind the
  server and rounds off corners instead of snapping them.
- Trail cells are painted one tick late, so a head is always drawn ahead of the
  line it is drawing rather than chasing it.

The remaining input delay is network round trip plus up to one tick of alignment.
Putting the function and Redis in the region closest to your players matters far
more here than any client-side trick.

## Bots

Bots keep the arena from feeling empty. They arrive when a human does and leave
with the last one, because keeping them alive with nobody watching would hold the
tick loop open and burn quota forever.

The strategy in `lib/game/bot.ts` is deliberately plain: carve a rectangle by
turning the same way every few cells, head home once the trail gets long, and
never take a step that runs into a wall or its own trail. Each candidate
direction is probed six cells ahead and scored by how far it stays survivable, so
a bot turns before it is trapped rather than after.

Someone else's trail is treated as free ground — running over it kills them, not
the bot.

## Layout

```
lib/game/arena.ts       pure simulation — movement, collisions, capture. No I/O.
lib/game/bot.ts         bot steering
lib/game/match.ts       leader election, game loop, snapshots, records
lib/game/constants.ts   arena size, tick rate, colours, Redis keys
lib/bus.ts              cross-instance pub/sub over Redis
lib/redis.ts            command connection and a separate subscriber connection
api/ws.ts               WebSocket server — exports an http.Server instance
public/                 client: canvas, HUD, touch controls
test/                   19 tests for the rules and the bots
```

`arena.ts` knows nothing about sockets or Redis, so every rule can be tested
without starting a server:

```bash
npm test
```

## Rules

- You start on a 5×5 block, facing the roomiest side of the arena
- Outside your own land you leave a trail
- Get back onto your own land and the trail becomes yours, **along with
  everything it enclosed**
- Touching a trail kills **its owner**, not whoever touched it
- Land cut off from the piece you are standing on is lost — carve through
  someone's territory and the far side of the cut goes back to neutral rather
  than leaving them islands they can never reach
- Losing your last cell is fatal: with no land there is no trail to bank
- Your own trail, the arena edge and head-on collisions are all fatal
- Dying releases all your land; you respawn three seconds later
- Reversing is only blocked while you are dragging a trail

Capture is computed backwards: flood the arena inward from its edges, and
whatever the flood never reaches must be enclosed. One flood fill over the whole
grid, roughly 0.1 ms.

The connectivity rule runs on the same idea. Anyone who lost ground during a tick
has their territory split into orthogonally connected pieces; the piece holding
the player survives, or the largest one if they are out on a trail, and the rest
is released. It only runs for players who actually lost cells, so a quiet tick
costs nothing.

## Controls

`WASD` or the arrow keys. On a touch screen, drag anywhere — the joystick appears
under your thumb.

## Running locally

```bash
npm install
npm test

npm i -g vercel
vercel link
vercel dev            # http://localhost:3000
```

Redis is optional for single-process development. Without `REDIS_URL` the arena
still runs, with no leader election and no all-time records.

```bash
docker run -d -p 6379:6379 --name territory-redis redis
# REDIS_URL=redis://localhost:6379 in .env.local
```

## Deploying

1. **Fluid compute must be enabled** (Settings → Functions). WebSockets do not
   work without it.
2. Add Redis from the Vercel Marketplace and connect it to the project. The code
   reads `REDIS_URL` or `KV_URL`.
3. Put Redis in the same region as the function. The simulation touches Redis ten
   times a second; split across continents, the game feels heavy.
4. `vercel --prod`

Quick check: `curl https://<domain>/api/ws` reports Redis status, local
connection count and which instance is leading.

## Quota

Roughly 40,000 Redis commands an hour with a busy arena, so the Upstash free tier
(500,000 commands a month) covers about twelve hours of play. An empty arena
costs nothing. To stretch it further, lower the tick rate in
`lib/game/constants.ts` or snapshot less often.

## Notes

`tsconfig.json` uses `module: Node16`. Bundler-style settings (`ESNext` with
`moduleResolution: Bundler`) make every function fail to load on Vercel with
`FUNCTION_INVOCATION_FAILED`, because the compiled output is ESM while the
runtime loads it as CommonJS.
