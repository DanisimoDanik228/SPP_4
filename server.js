'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const C = require('./shared/constants');
const { Store } = require('./lib/store');
const { WebSocketServer } = require('./lib/ws');
const { Game } = require('./lib/game');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.GAME_DATA || path.join(ROOT, C.DATA_FILE);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const store = new Store(DATA_FILE, { tick: 0, nextId: 1, profiles: [], orbs: [], savedAt: 0 });
const game = new Game(store.data);

let saveTimer = null;
let tickTimer = null;

function persist() {
  try {
    store.save(game.serialize());
  } catch (err) {
    console.error('[save] failed:', err.message);
  }
}

function serveFile(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  if (rel === '/shared/constants.js') rel = '/shared/constants.js';

  const base = rel.startsWith('/shared/') ? ROOT : PUBLIC_DIR;
  const target = path.normalize(path.join(base, rel));
  const allowed = base === ROOT ? path.join(ROOT, 'shared') : PUBLIC_DIR;
  if (target !== allowed && !target.startsWith(allowed + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, players: game.playerCount, tick: game.tick }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  serveFile(req, res, url.pathname);
});

const wss = new WebSocketServer({ server, path: '/ws', pingInterval: 25000 });

let connSeq = 0;

wss.on('connection', (conn) => {
  conn.id = ++connSeq;
  let playerId = null;

  const send = (obj) => {
    try {
      conn.send(JSON.stringify(obj));
    } catch (e) {}
  };

  conn.on('message', (raw) => {
    if (typeof raw !== 'string') return;
    if (raw.length > 2048) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (playerId) return;
      const res = game.join(msg.name, 'c' + conn.id);
      if (res.error) {
        send({ t: 'error', code: res.error });
        conn.close(1008, res.error);
        return;
      }
      playerId = res.player.id;
      send({
        t: 'welcome',
        id: playerId,
        name: res.player.name,
        resumed: res.resumed,
        world: C.WORLD,
        tickMs: C.TICK_MS,
        you: res.player
      });
      send({ t: 'snapshot', snap: game.snapshot(), events: [{ k: 'join', id: playerId, name: res.player.name }] });
      return;
    }

    if (msg.t === 'input') {
      if (!playerId) return;
      game.setInput(playerId, msg);
      return;
    }
  });

  conn.on('close', () => {
    if (playerId) {
      game.leave(playerId);
      playerId = null;
    }
  });
});

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const conn of wss.connections) {
    try {
      conn.send(payload);
    } catch (e) {}
  }
}

function startLoops() {
  tickTimer = setInterval(() => {
    game.update();
    const events = game.drainEvents();
    broadcast({ t: 'snapshot', snap: game.snapshot(), events });
  }, C.TICK_MS);

  saveTimer = setInterval(persist, C.SAVE_MS);
}

function stopLoops() {
  if (tickTimer) clearInterval(tickTimer);
  if (saveTimer) clearInterval(saveTimer);
  tickTimer = null;
  saveTimer = null;
}

function shutdown(signal) {
  console.log('\n[' + signal + '] Saving game state and shutting down...');
  stopLoops();
  persist();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  try {
    persist();
  } catch (e) {}
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    startLoops();
    console.log('Neon Arena running at http://localhost:' + PORT);
    console.log('WebSocket endpoint: ws://localhost:' + PORT + '/ws');
    console.log('Persistence file: ' + DATA_FILE);
  });
}

module.exports = { server, wss, game, store, persist, startLoops, stopLoops };
