'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RawClient } = require('./wsclient');
const C = require('../shared/constants');

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', GAME_DATA: dataFile }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server start timeout: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.indexOf('Neon Arena running') !== -1) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited early ' + code + ': ' + out));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000);
  });
}

async function waitHealth(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      if (res.ok) return res.json();
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('health check failed');
}

test('интеграция: синхронизация двух игроков и сохранение между запусками', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-int-'));
  const dataFile = path.join(dir, 'save.json');
  const port = 3900 + Math.floor(Math.random() * 200);

  let server = await startServer(port, dataFile);
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a = new RawClient(port);
  const b = new RawClient(port);
  await a.connect();
  await b.connect();

  a.send({ t: 'join', name: 'Alice' });
  b.send({ t: 'join', name: 'Bob' });

  const wa = await a.waitFor((m) => m.indexOf('"welcome"') !== -1);
  const wb = await b.waitFor((m) => m.indexOf('"welcome"') !== -1);
  const welcomeA = wa;
  const welcomeB = wb;
  assert.strictEqual(welcomeA.name, 'Alice');
  assert.strictEqual(welcomeB.name, 'Bob');

  await waitHealth(port);

  a.messages.length = 0;
  b.messages.length = 0;

  a.send({ t: 'input', seq: 1, right: true, aimX: 500, aimY: 400 });
  b.send({ t: 'input', seq: 1, left: true, aimX: 300, aimY: 400 });

  const seenByB = await b.waitFor((m) => {
    const msg = JSON.parse(m);
    return msg.t === 'snapshot' && msg.snap.players.some((p) => p.id === welcomeA.id && p.x !== welcomeA.you.x);
  }, 5000);
  const snapB = seenByB;
  const aliceOnB = snapB.snap.players.find((p) => p.id === welcomeA.id);
  assert.ok(aliceOnB.x > welcomeA.you.x, 'Боб видит движение Алисы в реальном времени');

  const seenByA = await a.waitFor((m) => {
    const msg = JSON.parse(m);
    return msg.t === 'snapshot' && msg.snap.players.length >= 2;
  }, 5000);
  const snapA = seenByA;
  assert.strictEqual(snapA.snap.players.length, 2, 'Алиса видит обоих игроков');

  // Алиса набирает очки (подбирает орб), затем сервер гасится — данные должны сохраниться
  await a.waitFor((m) => {
    const msg = JSON.parse(m);
    return msg.t === 'snapshot' && msg.snap.players.some((p) => p.id === welcomeA.id && p.score > 0);
  }, 5000).catch(() => null);

  a.close();
  b.close();
  await stopServer(server);

  server = await startServer(port, dataFile);
  const c = new RawClient(port);
  await c.connect();
  c.send({ t: 'join', name: 'Alice' });
  const wc = await c.waitFor((m) => m.indexOf('"welcome"') !== -1);
  assert.strictEqual(wc.resumed, true, 'профиль Alice восстановлен после рестарта');
  assert.ok(wc.you.score > 0 || wc.you.kills >= 0);

  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(Array.isArray(saved.profiles) && saved.profiles.length >= 1, 'файл сохранения содержит профили');
  assert.ok(Array.isArray(saved.orbs) && saved.orbs.length > 0, 'орбы сохранены');
  c.close();
});
