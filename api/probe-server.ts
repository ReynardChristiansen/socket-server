// PROBE SEMENTARA — hapus setelah selesai debug.
// Persis contoh resmi Vercel: export http.Server + ws, TANPA redis dan
// TANPA import dari ../lib. Kalau ini jalan tapi /api/ws tetap gagal,
// berarti penyebabnya ada di redis atau di import lintas folder.
import http from 'http';
import { WebSocketServer } from 'ws';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, probe: 'export-http-server' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => ws.send(data));
});

export default server;
