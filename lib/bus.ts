import { getClient, getSubscriber, redisEnabled } from './redis';

export type Handler = (payload: any) => void;

const handlers = new Map<string, Set<Handler>>();

let warned = false;
function warnLocalOnly(): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[bus] REDIS_URL is not set — messages only reach sockets on this instance. ' +
      'Fine for single-process development, not enough for production.',
  );
}

function dispatch(channel: string, raw: string): void {
  const set = handlers.get(channel);
  if (!set || set.size === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error(`[bus] payload on ${channel} was not JSON`);
    return;
  }
  for (const handler of set) handler(payload);
}

/** Start listening on a channel. Called when the first player needs it. */
export async function subscribe(channel: string, handler: Handler): Promise<void> {
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    if (redisEnabled) {
      const sub = await getSubscriber();
      await sub.subscribe(channel, (raw) => dispatch(channel, raw));
    }
  }
  set.add(handler);
}

export async function unsubscribe(channel: string, handler: Handler): Promise<void> {
  const set = handlers.get(channel);
  if (!set) return;

  set.delete(handler);
  if (set.size > 0) return;

  handlers.delete(channel);
  if (redisEnabled) {
    const sub = await getSubscriber();
    await sub.unsubscribe(channel);
  }
}

/**
 * The only route messages take between users. The receiving instance publishes
 * to Redis, and every instance — including this one — gets it back through its
 * subscription and forwards it to its own sockets.
 */
export async function publish(channel: string, payload: unknown): Promise<void> {
  const raw = JSON.stringify(payload);

  if (!redisEnabled) {
    warnLocalOnly();
    dispatch(channel, raw);
    return;
  }

  const client = await getClient();
  await client.publish(channel, raw);
}
