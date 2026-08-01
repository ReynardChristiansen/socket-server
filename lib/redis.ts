import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? '';

/** Redis is required in production. Without it instances cannot see each other. */
export const redisEnabled = REDIS_URL.length > 0;

let clientPromise: Promise<RedisClient> | null = null;
let subscriberPromise: Promise<RedisClient> | null = null;

async function connect(label: string): Promise<RedisClient> {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error(`[redis:${label}] ${String(err)}`));
  await client.connect();
  console.log(`[redis:${label}] connected`);
  return client;
}

/** Connection for ordinary commands (ZADD, SET, ...) and for PUBLISH. */
export function getClient(): Promise<RedisClient> {
  if (!redisEnabled) throw new Error('REDIS_URL is not set');
  clientPromise ??= connect('client');
  return clientPromise;
}

/**
 * Separate connection dedicated to SUBSCRIBE. Redis rejects ordinary commands
 * on a subscribed connection, so this must never be shared with getClient().
 */
export function getSubscriber(): Promise<RedisClient> {
  if (!redisEnabled) throw new Error('REDIS_URL is not set');
  subscriberPromise ??= connect('subscriber');
  return subscriberPromise;
}
