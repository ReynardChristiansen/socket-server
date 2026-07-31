// PROBE SEMENTARA — hapus setelah selesai debug.
// JavaScript murni, sama sekali tidak lewat kompilasi TypeScript.
// Kalau ini jalan tapi probe .ts gagal, berarti masalahnya memang di tsconfig.
module.exports = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, probe: 'javascript-murni' }));
};
