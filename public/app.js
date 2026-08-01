// Client Territory. Server yang memutuskan segalanya; di sini cuma menggambar
// dan mengirim arah. Posisi diinterpolasi supaya 10 tick per detik terlihat halus.

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const ctx = stage.getContext('2d', { alpha: false });
const minimap = $('minimap');
const miniCtx = minimap.getContext('2d');

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STICK_DEADZONE = 18;
const DIR_KEYS = {
  ArrowUp: 0, KeyW: 0,
  ArrowRight: 1, KeyD: 1,
  ArrowDown: 2, KeyS: 2,
  ArrowLeft: 3, KeyA: 3,
};

const S = {
  w: 0,
  h: 0,
  tickMs: 100,
  colors: [],
  rgb: [],
  trailColors: [],
  owner: new Int8Array(0),
  trails: [],
  players: new Map(),
  names: new Map(),
  myId: localStorage.getItem('territory:id') || null,
  mySlot: null,
  myBest: 0,
  lastTickAt: 0,
  camX: 50,
  camY: 50,
  camReady: false,
  joined: false,
  playing: false,
};

let socket = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let lastSentDir = null;
let deadUntil = 0;

let terr = null;
let terrCtx = null;
let trailLayer = null;
let trailCtx = null;

// ------------------------------------------------------------------- warna

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const colorOf = (slot) => S.colors[slot % S.colors.length] || '#888';

/** Jejak dibuat lebih terang dari wilayah supaya bahaya langsung terbaca —
 *  kalau warnanya sama persis, pemain tidak bisa membedakan mana yang aman
 *  dipijak dan mana yang mematikan. */
function lighten(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const trailColorOf = (slot) => S.trailColors[slot % S.trailColors.length] || '#bbb';

// -------------------------------------------------------------------- grid

function initGrid(w, h, maxPlayers) {
  S.w = w;
  S.h = h;
  S.owner = new Int8Array(w * h).fill(-1);
  S.trails = Array.from({ length: maxPlayers }, () => new Set());

  terr = document.createElement('canvas');
  terr.width = w;
  terr.height = h;
  terrCtx = terr.getContext('2d');

  trailLayer = document.createElement('canvas');
  trailLayer.width = w;
  trailLayer.height = h;
  trailCtx = trailLayer.getContext('2d');
}

function paintOwner(idx, slot) {
  const x = idx % S.w;
  const y = (idx / S.w) | 0;
  if (slot < 0) {
    terrCtx.clearRect(x, y, 1, 1);
  } else {
    terrCtx.fillStyle = colorOf(slot);
    terrCtx.fillRect(x, y, 1, 1);
  }
}

/** Gambar ulang seluruh wilayah sekaligus lewat ImageData — jauh lebih cepat
 *  daripada 10.000 kali fillRect saat baru masuk atau reconnect. */
function repaintTerritory() {
  const image = terrCtx.createImageData(S.w, S.h);
  const data = image.data;
  for (let i = 0; i < S.owner.length; i++) {
    const slot = S.owner[i];
    if (slot < 0) continue;
    const [r, g, b] = S.rgb[slot % S.rgb.length];
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  terrCtx.putImageData(image, 0, 0);
}

function paintTrail(idx, slot) {
  const x = idx % S.w;
  const y = (idx / S.w) | 0;
  trailCtx.fillStyle = trailColorOf(slot);
  trailCtx.fillRect(x, y, 1, 1);
}

function clearTrail(slot) {
  const cells = S.trails[slot];
  if (!cells) return;
  for (const idx of cells) trailCtx.clearRect(idx % S.w, (idx / S.w) | 0, 1, 1);
  cells.clear();
}

function rleDecode(data, out) {
  let i = 0;
  for (let k = 0; k < data.length; k += 2) {
    out.fill(data[k], i, i + data[k + 1]);
    i += data[k + 1];
  }
}

// ---------------------------------------------------------------- jaringan

function connect() {
  clearTimeout(reconnectTimer);
  setStatus('menyambung', '');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/api/ws`);

  socket.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setStatus('tersambung', 'online');
    lastSentDir = null;
    // Kirim ulang identitas: server memakai id yang sama untuk melanjutkan
    // wilayah yang tadi, bukan menganggap ini pemain baru.
    if (S.joined) sendJoin();
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('close', () => {
    setStatus(`putus, ulangi ${Math.round(reconnectDelay / 1000)}s`, 'offline');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });

  socket.addEventListener('error', () => socket.close());
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendJoin() {
  send({ k: 'join', id: S.myId, name: localStorage.getItem('territory:name') || '' });
}

function handle(msg) {
  switch (msg.k) {
    case 'welcome':
      S.myId = msg.id;
      localStorage.setItem('territory:id', msg.id);
      S.tickMs = msg.tickMs;
      S.colors = msg.colors;
      S.rgb = msg.colors.map(hexToRgb);
      S.trailColors = msg.colors.map((c) => lighten(c, 0.5));
      initGrid(msg.grid.w, msg.grid.h, msg.maxPlayers);
      return;

    case 'snap':
      applySnapshot(msg);
      return;

    case 'tick':
      applyTick(msg);
      return;

    case 'roster':
      S.names.clear();
      for (const p of msg.players) {
        S.names.set(p.slot, p.name);
        if (p.id === S.myId) S.mySlot = p.slot;
      }
      return;

    case 'best':
      renderBest(msg.rows);
      return;

    case 'full':
      showStartError('Arena sedang penuh. Coba lagi sebentar lagi.');
      return;

    case 'err':
      showStartError(msg.msg);
      return;
  }
}

function applySnapshot(msg) {
  rleDecode(msg.owner, S.owner);
  repaintTerritory();

  trailCtx.clearRect(0, 0, S.w, S.h);
  for (const set of S.trails) set.clear();
  S.players.clear();
  S.names.clear();
  S.mySlot = null;

  for (const p of msg.players) {
    S.names.set(p.slot, p.name);
    if (p.id === S.myId) S.mySlot = p.slot;
    S.players.set(p.slot, {
      slot: p.slot,
      x: p.x,
      y: p.y,
      px: p.x,
      py: p.y,
      dir: p.dir,
      alive: p.alive,
      cells: p.cells,
      kills: 0,
    });
    for (const idx of p.trail) {
      S.trails[p.slot].add(idx);
      paintTrail(idx, p.slot);
    }
  }

  const me = S.players.get(S.mySlot);
  if (me) {
    S.camX = me.x;
    S.camY = me.y;
    S.camReady = true;
  }

  S.lastTickAt = performance.now();
  if (!S.playing) startPlaying();
  updateHud();
}

function applyTick(msg) {
  const ev = msg.ev;
  if (ev) {
    if (ev.freed) {
      for (const idx of ev.freed) {
        S.owner[idx] = -1;
        paintOwner(idx, -1);
      }
    }
    if (ev.spawns) {
      for (const spawn of ev.spawns) {
        for (const idx of spawn.cells) {
          S.owner[idx] = spawn.slot;
          paintOwner(idx, spawn.slot);
        }
      }
    }
    if (ev.captures) {
      for (const cap of ev.captures) {
        for (const idx of cap.cells) {
          S.owner[idx] = cap.slot;
          paintOwner(idx, cap.slot);
        }
      }
    }
    if (ev.clearTrails) for (const slot of ev.clearTrails) clearTrail(slot);
    if (ev.deaths) for (const death of ev.deaths) onDeath(death);
  }

  const seen = new Set();
  for (const [slot, x, y, dir, alive, cells, kills] of msg.players) {
    seen.add(slot);
    let p = S.players.get(slot);
    if (!p) {
      p = { slot, x, y, px: x, py: y, dir, alive: !!alive, cells, kills };
      S.players.set(slot, p);
    } else {
      // Lompatan jauh berarti lahir kembali, bukan gerak — jangan diinterpolasi.
      const jumped = Math.abs(x - p.x) + Math.abs(y - p.y) > 2;
      p.px = jumped ? x : p.x;
      p.py = jumped ? y : p.y;
      p.x = x;
      p.y = y;
      p.dir = dir;
      p.alive = !!alive;
      p.cells = cells;
      p.kills = kills;
    }

    if (alive) {
      const idx = y * S.w + x;
      if (S.owner[idx] !== slot && !S.trails[slot].has(idx)) {
        S.trails[slot].add(idx);
        paintTrail(idx, slot);
      }
    }
  }

  for (const slot of [...S.players.keys()]) {
    if (!seen.has(slot)) {
      clearTrail(slot);
      S.players.delete(slot);
    }
  }

  const me = S.players.get(S.mySlot);
  if (me) {
    if (me.cells > S.myBest) S.myBest = me.cells;
    if (me.alive && deadUntil > 0) hideDead();
    if (!S.camReady) {
      S.camX = me.x;
      S.camY = me.y;
      S.camReady = true;
    }
  }

  S.lastTickAt = performance.now();
  updateHud();
}

// ------------------------------------------------------------------ tampilan

/** Berapa sel yang muat di sisi terpanjang layar. Dihitung dari sisi terpanjang,
 *  bukan terpendek, supaya di monitor lebar arenanya tidak terlihat terlalu jauh. */
function viewSpan() {
  return matchMedia('(pointer: coarse)').matches ? 32 : 52;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  stage.width = Math.round(stage.clientWidth * dpr);
  stage.height = Math.round(stage.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!S.w) return;

  const alpha = Math.min(1, (now - S.lastTickAt) / S.tickMs);
  const me = S.players.get(S.mySlot);
  if (me) {
    // Kamera ikut posisi terinterpolasi, lalu dihaluskan lagi supaya tidak kaku.
    const tx = me.px + (me.x - me.px) * alpha;
    const ty = me.py + (me.y - me.py) * alpha;
    S.camX += (tx - S.camX) * 0.25;
    S.camY += (ty - S.camY) * 0.25;
  }

  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const cell = Math.max(w, h) / viewSpan();

  // Kamera ditahan di dalam arena. Tanpa ini, pemain yang bermain dekat tepi
  // melihat sebagian besar layarnya jadi ruang hitam kosong di luar papan.
  const viewW = w / cell;
  const viewH = h / cell;
  const camX = viewW >= S.w ? S.w / 2 : clamp(S.camX, viewW / 2 - 0.5, S.w - viewW / 2 - 0.5);
  const camY = viewH >= S.h ? S.h / 2 : clamp(S.camY, viewH / 2 - 0.5, S.h - viewH / 2 - 0.5);

  const originX = w / 2 - camX * cell - cell / 2;
  const originY = h / 2 - camY * cell - cell / 2;

  ctx.fillStyle = '#08080c';
  ctx.fillRect(0, 0, w, h);

  const boardW = S.w * cell;
  const boardH = S.h * cell;

  ctx.fillStyle = '#101322';
  ctx.fillRect(originX, originY, boardW, boardH);

  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 0.92;
  ctx.drawImage(terr, originX, originY, boardW, boardH);
  ctx.globalAlpha = 1;

  if (cell >= 13) drawGridLines(originX, originY, cell, w, h);

  // Jejak digambar lebih menyala supaya bahaya terlihat jelas.
  ctx.globalAlpha = 0.95;
  ctx.drawImage(trailLayer, originX, originY, boardW, boardH);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(originX, originY, boardW, boardH);

  drawPlayers(originX, originY, cell, alpha);
  drawMinimap();
}

function drawGridLines(originX, originY, cell, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const firstX = Math.max(0, Math.floor(-originX / cell));
  const lastX = Math.min(S.w, Math.ceil((w - originX) / cell));
  for (let x = firstX; x <= lastX; x++) {
    const sx = Math.round(originX + x * cell) + 0.5;
    ctx.moveTo(sx, Math.max(0, originY));
    ctx.lineTo(sx, Math.min(h, originY + S.h * cell));
  }
  const firstY = Math.max(0, Math.floor(-originY / cell));
  const lastY = Math.min(S.h, Math.ceil((h - originY) / cell));
  for (let y = firstY; y <= lastY; y++) {
    const sy = Math.round(originY + y * cell) + 0.5;
    ctx.moveTo(Math.max(0, originX), sy);
    ctx.lineTo(Math.min(w, originX + S.w * cell), sy);
  }
  ctx.stroke();
}

function drawPlayers(originX, originY, cell, alpha) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (const p of S.players.values()) {
    if (!p.alive) continue;

    const ix = p.px + (p.x - p.px) * alpha;
    const iy = p.py + (p.y - p.py) * alpha;
    const sx = originX + ix * cell;
    const sy = originY + iy * cell;
    const isMe = p.slot === S.mySlot;
    const size = cell * (isMe ? 1.5 : 1.3);

    if (isMe) {
      ctx.shadowColor = colorOf(p.slot);
      ctx.shadowBlur = cell * 1.1;
    }
    ctx.fillStyle = colorOf(p.slot);
    roundRect(sx + cell / 2 - size / 2, sy + cell / 2 - size / 2, size, size, size * 0.28);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.lineWidth = Math.max(1.5, cell * 0.13);
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.45)';
    ctx.stroke();

    const name = S.names.get(p.slot);
    if (name) {
      ctx.font = `600 ${Math.max(10, Math.min(14, cell * 0.62))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.72)';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      const label = isMe ? `${name} (kamu)` : name;
      ctx.strokeText(label, sx + cell / 2, sy - cell * 0.35);
      ctx.fillText(label, sx + cell / 2, sy - cell * 0.35);
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMinimap() {
  const size = minimap.width;
  miniCtx.fillStyle = '#0b0d16';
  miniCtx.fillRect(0, 0, size, size);
  miniCtx.imageSmoothingEnabled = false;
  miniCtx.drawImage(terr, 0, 0, size, size);

  const me = S.players.get(S.mySlot);
  if (!me) return;
  const scale = size / S.w;
  miniCtx.fillStyle = '#fff';
  miniCtx.beginPath();
  miniCtx.arc(me.x * scale, me.y * scale, 2.5, 0, Math.PI * 2);
  miniCtx.fill();
}

// --------------------------------------------------------------------- HUD

function updateHud() {
  const total = S.w * S.h;
  const rows = [...S.players.values()].sort((a, b) => b.cells - a.cells);
  const me = S.players.get(S.mySlot);

  $('scoreValue').textContent = me ? ((me.cells / total) * 100).toFixed(2) : '0.00';
  $('scoreRank').textContent = me
    ? `peringkat ${rows.findIndex((p) => p.slot === S.mySlot) + 1} dari ${rows.length}`
    : 'menonton';
  $('scoreKills').textContent = `${me?.kills ?? 0} tumbang`;

  const board = $('board');
  board.replaceChildren(
    ...rows.slice(0, 5).map((p) => {
      const li = document.createElement('li');
      if (p.slot === S.mySlot) li.className = 'me';
      else if (!p.alive) li.className = 'gone';

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = colorOf(p.slot);

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = S.names.get(p.slot) || '—';

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = `${((p.cells / total) * 100).toFixed(2)}%`;

      li.append(swatch, who, val);
      return li;
    }),
  );
}

function renderBest(rows) {
  const total = S.w * S.h || 10000;
  const list = $('bestList');
  if (!rows || rows.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'empty',
      textContent: 'belum ada rekor',
    }));
    return;
  }
  list.replaceChildren(
    ...rows.map((row, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'swatch';
      rank.style.background = ['#fbbf24', '#cbd5e1', '#b45309', '#3f3f46', '#3f3f46'][i] || '#3f3f46';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = row.name;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = `${((row.cells / total) * 100).toFixed(2)}%`;
      li.append(rank, who, val);
      return li;
    }),
  );
}

function setStatus(text, cls) {
  $('statusText').textContent = text;
  $('status').className = `status ${cls}`;
}

function showStartError(text) {
  const box = $('startError');
  box.textContent = text;
  box.hidden = false;
  $('playBtn').disabled = false;
}

function startPlaying() {
  S.playing = true;
  $('start').hidden = true;
  $('hud').hidden = false;
  if (matchMedia('(pointer: coarse)').matches) $('stick').hidden = false;
}

function onDeath(death) {
  if (death.slot !== S.mySlot) return;
  const total = S.w * S.h;
  const me = S.players.get(S.mySlot);

  $('deadScore').textContent = `${((S.myBest / total) * 100).toFixed(2)}%`;
  $('deadKills').textContent = String(me?.kills ?? 0);
  $('deadReason').textContent =
    death.killer !== null && death.killer !== S.mySlot
      ? `Dijegal ${S.names.get(death.killer) || 'lawan'}.`
      : 'Jejakmu terputus.';

  S.myBest = 0;
  deadUntil = performance.now() + 3000;
  $('dead').hidden = false;
  tickDeadCountdown();
}

function tickDeadCountdown() {
  if ($('dead').hidden) return;
  const left = Math.max(0, Math.ceil((deadUntil - performance.now()) / 1000));
  $('deadCount').textContent = String(left);
  if (left > 0) setTimeout(tickDeadCountdown, 200);
}

function hideDead() {
  deadUntil = 0;
  $('dead').hidden = true;
}

// ------------------------------------------------------------------ kontrol

function sendDir(dir) {
  if (dir === lastSentDir) return;
  lastSentDir = dir;
  send({ k: 'dir', d: dir });
}

window.addEventListener('keydown', (event) => {
  const dir = DIR_KEYS[event.code];
  if (dir === undefined || !S.playing) return;
  event.preventDefault();
  sendDir(dir);
});

const stick = $('stick');
const stickBase = stick.querySelector('.stick-base');
const stickKnob = stick.querySelector('.stick-knob');
let stickId = null;
let stickOrigin = null;

stage.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch' || !S.playing) return;
  stickId = event.pointerId;
  stickOrigin = { x: event.clientX, y: event.clientY };
  placeStick(stickBase, stickOrigin.x, stickOrigin.y);
  placeStick(stickKnob, stickOrigin.x, stickOrigin.y);
  stick.classList.add('on');
});

stage.addEventListener('pointermove', (event) => {
  if (event.pointerId !== stickId || !stickOrigin) return;
  const dx = event.clientX - stickOrigin.x;
  const dy = event.clientY - stickOrigin.y;
  const dist = Math.hypot(dx, dy);

  const clamped = Math.min(dist, 46);
  const angle = Math.atan2(dy, dx);
  placeStick(
    stickKnob,
    stickOrigin.x + Math.cos(angle) * clamped,
    stickOrigin.y + Math.sin(angle) * clamped,
  );

  if (dist < STICK_DEADZONE) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
});

function endStick(event) {
  if (event.pointerId !== stickId) return;
  stickId = null;
  stickOrigin = null;
  stick.classList.remove('on');
}

stage.addEventListener('pointerup', endStick);
stage.addEventListener('pointercancel', endStick);

function placeStick(el, x, y) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

// ------------------------------------------------------------------- mulai

$('joinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('nameInput').value.trim();
  if (name) localStorage.setItem('territory:name', name);
  $('startError').hidden = true;
  $('playBtn').disabled = true;
  S.joined = true;
  sendJoin();
});

$('nameInput').value = localStorage.getItem('territory:name') || '';

window.addEventListener('resize', resize);
resize();
connect();
requestAnimationFrame(frame);
