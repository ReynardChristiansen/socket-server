import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL ?? '';

/** Redis wajib di production. Tanpa ini, broadcast antar instance tidak jalan. */
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

/** Koneksi untuk command biasa (ZADD, LPUSH, ...) sekaligus PUBLISH. */
export function getClient(): Promise<RedisClient> {
  if (!redisEnabled) throw new Error('REDIS_URL belum diset');
  clientPromise ??= connect('client');
  return clientPromise;
}

/**
 * Koneksi terpisah khusus SUBSCRIBE. Redis melarang command biasa di koneksi
 * yang sedang subscribe, jadi ini tidak boleh dipakai ulang dari getClient().
 */
export function getSubscriber(): Promise<RedisClient> {
  if (!redisEnabled) throw new Error('REDIS_URL belum diset');
  subscriberPromise ??= connect('subscriber');
  return subscriberPromise;
}
