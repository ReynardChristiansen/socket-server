import { getClient, getSubscriber, redisEnabled } from './redis';

export type Handler = (payload: any) => void;

const handlers = new Map<string, Set<Handler>>();

let warned = false;
function warnLocalOnly(): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[bus] REDIS_URL tidak diset — broadcast hanya sampai ke koneksi di instance ini. ' +
      'Cukup untuk dev satu proses, TIDAK cukup untuk production.',
  );
}

function dispatch(channel: string, raw: string): void {
  const set = handlers.get(channel);
  if (!set || set.size === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error(`[bus] payload bukan JSON di channel ${channel}`);
    return;
  }
  for (const handler of set) handler(payload);
}

/** Instance ini mulai mendengarkan channel. Dipanggil saat koneksi pertama masuk room. */
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

/** Dipanggil saat koneksi lokal terakhir di room itu putus. */
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
 * Satu-satunya jalan keluar untuk pesan antar user.
 * Instance yang menerima pesan mem-publish ke Redis, lalu SEMUA instance
 * (termasuk instance ini sendiri) menerimanya lewat subscribe dan meneruskan
 * ke koneksi lokalnya masing-masing.
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
