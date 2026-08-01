// Territory client. The server decides everything; this file only draws and
// sends directions.
//
// Two details keep motion readable at ten server steps per second:
//
//   1. Heads are eased toward the authoritative cell with a short time
//      constant instead of being interpolated across a whole tick. That halves
//      the visual delay behind the server and rounds off corners.
//   2. Trail cells are painted one tick late, so the head is always drawn ahead
//      of its own trail rather than behind the line it is drawing.

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const ctx = stage.getContext('2d', { alpha: false });
const minimap = $('minimap');
const miniCtx = minimap.getContext('2d');

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STICK_DEADZONE = 14;
/** Easing time constants for head and camera motion, in milliseconds. */
const HEAD_SMOOTH_MS = 45;
const CAMERA_SMOOTH_MS = 90;
/** The HUD is text; refreshing it ten times a second is wasted work on phones. */
const HUD_INTERVAL_MS = 250;

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
  bots: new Set(),
  myId: localStorage.getItem('territory:id') || null,
  mySlot: null,
  myBest: 0,
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
let lastFrameAt = 0;
let hudDueAt = 0;

let terr = null;
let terrCtx = null;
let trailLayer = null;
let trailCtx = null;

// ------------------------------------------------------------------------ colour

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const colorOf = (slot) => S.colors[slot % S.colors.length] || '#888';

/** Trails are lighter than territory so danger reads at a glance — in the same
 *  colour there is no way to tell safe ground from a lethal line. */
function lighten(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const trailColorOf = (slot) => S.trailColors[slot % S.trailColors.length] || '#bbb';

// -------------------------------------------------------------------------- grid

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

/** Repaints the whole territory in one pass. Far cheaper than ten thousand
 *  fillRect calls when joining or reconnecting. */
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
  trailCtx.fillStyle = trailColorOf(slot);
  trailCtx.fillRect(idx % S.w, (idx / S.w) | 0, 1, 1);
}

function clearTrail(slot) {
  const cells = S.trails[slot];
  if (!cells) return;
  for (const idx of cells) trailCtx.clearRect(idx % S.w, (idx / S.w) | 0, 1, 1);
  cells.clear();
  const player = S.players.get(slot);
  if (player) player.pendingTrail = null;
}

function rleDecode(data, out) {
  let i = 0;
  for (let k = 0; k < data.length; k += 2) {
    out.fill(data[k], i, i + data[k + 1]);
    i += data[k + 1];
  }
}

// ---------------------------------------------------------------------- network

function connect() {
  clearTimeout(reconnectTimer);
  setStatus('connecting', '');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/api/ws`);

  socket.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setStatus('connected', 'online');
    lastSentDir = null;
    // Send the same identity back: the server resumes the old territory rather
    // than treating this as a brand new player.
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
    setStatus(`lost, retrying in ${Math.round(reconnectDelay / 1000)}s`, 'offline');
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
      S.bots.clear();
      for (const p of msg.players) {
        S.names.set(p.slot, p.name);
        if (p.bot) S.bots.add(p.slot);
        if (p.id === S.myId) S.mySlot = p.slot;
      }
      hudDueAt = 0;
      return;

    case 'best':
      renderBest(msg.rows);
      return;

    case 'full':
      showStartError('The arena is full right now. Try again in a moment.');
      return;

    case 'err':
      showStartError(msg.msg);
      return;
  }
}

function newPlayer(slot, x, y, dir, alive, cells, kills) {
  return {
    slot, x, y, dir, alive, cells, kills,
    // Rendered position, eased toward the authoritative cell every frame.
    rx: x,
    ry: y,
    // Cell recorded last tick, painted one tick late so the head stays in front.
    pendingTrail: null,
  };
}

function applySnapshot(msg) {
  rleDecode(msg.owner, S.owner);
  repaintTerritory();

  trailCtx.clearRect(0, 0, S.w, S.h);
  for (const set of S.trails) set.clear();
  S.players.clear();
  S.names.clear();
  S.bots.clear();
  S.mySlot = null;

  for (const p of msg.players) {
    S.names.set(p.slot, p.name);
    if (p.bot) S.bots.add(p.slot);
    if (p.id === S.myId) S.mySlot = p.slot;

    const player = newPlayer(p.slot, p.x, p.y, p.dir, p.alive, p.cells, 0);
    S.players.set(p.slot, player);

    // The newest trail cell is the one the head stands on, so hold it back a
    // tick instead of drawing a line in front of the player.
    for (let i = 0; i < p.trail.length; i++) {
      if (i === p.trail.length - 1) {
        player.pendingTrail = p.trail[i];
      } else {
        S.trails[p.slot].add(p.trail[i]);
        paintTrail(p.trail[i], p.slot);
      }
    }
  }

  const me = S.players.get(S.mySlot);
  if (me) {
    S.camX = me.x;
    S.camY = me.y;
    S.camReady = true;
  }

  if (!S.playing) startPlaying();
  hudDueAt = 0;
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
      p = newPlayer(slot, x, y, dir, !!alive, cells, kills);
      S.players.set(slot, p);
    } else {
      // A long jump means a respawn, not movement, so do not glide across it.
      if (Math.abs(x - p.x) + Math.abs(y - p.y) > 2) {
        p.rx = x;
        p.ry = y;
        p.pendingTrail = null;
      }
      p.x = x;
      p.y = y;
      p.dir = dir;
      p.alive = !!alive;
      p.cells = cells;
      p.kills = kills;
    }

    if (alive) {
      // Paint the cell recorded last tick, then hold the current one back.
      if (p.pendingTrail !== null && S.owner[p.pendingTrail] !== slot) {
        S.trails[slot].add(p.pendingTrail);
        paintTrail(p.pendingTrail, slot);
      }
      const idx = y * S.w + x;
      p.pendingTrail = S.owner[idx] === slot ? null : idx;
    } else {
      p.pendingTrail = null;
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
}

// --------------------------------------------------------------------- rendering

/** How many cells fit along the longest edge. Measured on the longest edge, not
 *  the shortest, or the arena looks far too zoomed out on wide monitors. */
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

  const dt = lastFrameAt === 0 ? 16 : Math.min(100, now - lastFrameAt);
  lastFrameAt = now;

  const headEase = 1 - Math.exp(-dt / HEAD_SMOOTH_MS);
  for (const p of S.players.values()) {
    p.rx += (p.x - p.rx) * headEase;
    p.ry += (p.y - p.ry) * headEase;
  }

  const me = S.players.get(S.mySlot);
  if (me) {
    const camEase = 1 - Math.exp(-dt / CAMERA_SMOOTH_MS);
    S.camX += (me.rx - S.camX) * camEase;
    S.camY += (me.ry - S.camY) * camEase;
  }

  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const cell = Math.max(w, h) / viewSpan();

  // Hold the camera inside the arena. Without this, anyone playing near an edge
  // watches most of their screen turn into empty black space off the board.
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

  ctx.drawImage(trailLayer, originX, originY, boardW, boardH);

  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(originX, originY, boardW, boardH);

  drawPlayers(originX, originY, cell);
  drawMinimap();

  if (now >= hudDueAt) {
    hudDueAt = now + HUD_INTERVAL_MS;
    updateHud();
  }
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

function drawPlayers(originX, originY, cell) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (const p of S.players.values()) {
    if (!p.alive) continue;

    const sx = originX + p.rx * cell;
    const sy = originY + p.ry * cell;
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
      const label = isMe ? `${name} (you)` : name;
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
  miniCtx.arc(me.rx * scale, me.ry * scale, 2.5, 0, Math.PI * 2);
  miniCtx.fill();
}

// -------------------------------------------------------------------------- HUD

function updateHud() {
  const total = S.w * S.h;
  const rows = [...S.players.values()].sort((a, b) => b.cells - a.cells);
  const me = S.players.get(S.mySlot);

  $('scoreValue').textContent = me ? ((me.cells / total) * 100).toFixed(2) : '0.00';
  $('scoreRank').textContent = me
    ? `rank ${rows.findIndex((p) => p.slot === S.mySlot) + 1} of ${rows.length}`
    : 'spectating';
  $('scoreKills').textContent = `${me?.kills ?? 0} taken down`;

  $('board').replaceChildren(
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

      li.append(swatch, who);
      if (S.bots.has(p.slot)) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'bot';
        li.append(tag);
      }

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = `${((p.cells / total) * 100).toFixed(2)}%`;
      li.append(val);
      return li;
    }),
  );
}

function renderBest(rows) {
  const total = S.w * S.h || 10000;
  const list = $('bestList');
  if (!rows || rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no records yet';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...rows.map((row, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'swatch';
      rank.style.background =
        ['#fbbf24', '#cbd5e1', '#b45309', '#3f3f46', '#3f3f46'][i] || '#3f3f46';
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
      ? `${S.names.get(death.killer) || 'Someone'} cut your trail.`
      : 'Your trail was broken.';

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

// ---------------------------------------------------------------------- controls

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

  const angle = Math.atan2(dy, dx);
  const clamped = Math.min(dist, 46);
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

// ------------------------------------------------------------------------ start

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
