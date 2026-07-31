import { getClient, redisEnabled } from './redis';

/** Presence dianggap basi kalau tidak di-refresh selama ini. */
const PRESENCE_TTL_MS = 30_000;
const HISTORY_LIMIT = 50;
/** Room yang tidak dipakai lagi hilang sendiri, tidak perlu cleanup manual. */
const KEY_TTL_SECONDS = 3600;

export type ChatMessage = {
  id: string;
  room: string;
  user: string;
  text: string;
  ts: number;
};

export const roomChannel = (room: string): string => `room:${room}`;
const presenceKey = (room: string): string => `room:${room}:presence`;
const historyKey = (room: string): string => `room:${room}:history`;

/**
 * Member disimpan sebagai `<connectionId>:<user>` supaya satu user yang buka
 * dua tab tidak saling menghapus presence-nya sendiri saat salah satunya putus.
 */
export const memberId = (connectionId: string, user: string): string =>
  `${connectionId}:${user}`;

const userFromMember = (member: string): string =>
  member.slice(member.indexOf(':') + 1);

/** Tandai koneksi ini masih hidup di room. Dipanggil saat join dan tiap heartbeat. */
export async function touchPresence(room: string, member: string): Promise<void> {
  if (!redisEnabled) return;
  const client = await getClient();
  const key = presenceKey(room);
  await client.zAdd(key, { score: Date.now(), value: member });
  await client.expire(key, KEY_TTL_SECONDS);
}

export async function dropPresence(room: string, member: string): Promise<void> {
  if (!redisEnabled) return;
  const client = await getClient();
  await client.zRem(presenceKey(room), member);
}

/**
 * Buang koneksi yang tidak sempat mengirim leave — instance-nya kena max duration,
 * crash, atau deployment-nya sudah diganti.
 */
export async function prunePresence(room: string): Promise<number> {
  if (!redisEnabled) return 0;
  const client = await getClient();
  return client.zRemRangeByScore(presenceKey(room), 0, Date.now() - PRESENCE_TTL_MS);
}

/** Daftar user unik di room, gabungan dari semua instance. */
export async function listMembers(room: string): Promise<string[]> {
  if (!redisEnabled) return [];
  const client = await getClient();
  const members = await client.zRange(presenceKey(room), 0, -1);
  return [...new Set(members.map(userFromMember))].sort((a, b) => a.localeCompare(b));
}

export async function pushHistory(room: string, message: ChatMessage): Promise<void> {
  if (!redisEnabled) return;
  const client = await getClient();
  const key = historyKey(room);
  await client.lPush(key, JSON.stringify(message));
  await client.lTrim(key, 0, HISTORY_LIMIT - 1);
  await client.expire(key, KEY_TTL_SECONDS);
}

/** Dikirim ke client tiap kali dia join — termasuk setelah reconnect. */
export async function readHistory(room: string): Promise<ChatMessage[]> {
  if (!redisEnabled) return [];
  const client = await getClient();
  const raw = await client.lRange(historyKey(room), 0, HISTORY_LIMIT - 1);

  const messages: ChatMessage[] = [];
  for (const item of raw) {
    try {
      messages.push(JSON.parse(item) as ChatMessage);
    } catch {
      // entri rusak, lewati saja
    }
  }
  return messages.reverse();
}
