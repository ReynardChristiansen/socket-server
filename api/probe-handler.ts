// PROBE SEMENTARA — hapus setelah selesai debug.
// Function paling polos: tanpa dependency, tanpa import dari ../lib.
// Kalau ini pun gagal, masalahnya di konfigurasi build/tsconfig, bukan di kode WebSocket.
import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, probe: 'handler-biasa' }));
}
