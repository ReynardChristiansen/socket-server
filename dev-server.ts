/**
 * Local development server.
 *
 * `vercel dev` is the faithful way to run this project, but it needs the folder
 * linked to a Vercel project first. This serves the same thing without any of
 * that: the WebSocket endpoint from api/ws.ts plus the static files in public/.
 *
 * Run it with `npm run dev:local`.
 *
 * Without REDIS_URL the arena lives in this one process, which is exactly what
 * you want for local play — see lib/bus.ts.
 */
import fs from 'fs';
import path from 'path';

import server from './api/ws';

const PORT = Number(process.env.PORT ?? 3000);
const publicDir = path.join(process.cwd(), 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// api/ws.ts already answers plain requests with its health payload. Keep that
// handler for /api/* and take over everything else with the static files.
const apiHandler = server.listeners('request')[0] as (req: unknown, res: unknown) => void;
server.removeAllListeners('request');

server.on('request', (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url.startsWith('/api/')) {
    apiHandler(req, res);
    return;
  }

  const requested = url === '/' ? '/index.html' : url;
  const full = path.join(publicDir, requested);

  // Reject anything that escapes public/ once resolved.
  if (!full.startsWith(publicDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(full)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[dev] Territory running at http://localhost:${PORT}`);
});
