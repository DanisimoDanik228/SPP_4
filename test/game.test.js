'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Game, sanitizeName, normalizeInput } = require('../lib/game');
const C = require('../shared/constants');

test('sanitizeName: чистка и обрезка', () => {
  assert.strictEqual(sanitizeName('  <>Admin<>  '), 'Admin');
  assert.strictEqual(sanitizeName('a'.repeat(50)).length, 16);
  assert.strictEqual(sanitizeName(null), '');
});

test('normalizeInput: булевы флаги и seq', () => {
  const i = normalizeInput({ up: 1, fire: 'yes', seq: 5, aimX: 100, aimY: 200 });
  assert.strictEqual(i.up, true);
  assert.strictEqual(i.fire, true);
  assert.strictEqual(i.seq, 5);
  assert.strictEqual(i.aimX, 100);
});

test('join: игрок появляется в мире, дубли имени разрешаются', () => {
  const g = new Game();
  const r1 = g.join('Neo');
  const r2 = g.join('Neo');
  assert.ok(r1.player);
  assert.strictEqual(r1.player.name, 'Neo');
  assert.strictEqual(r2.player.name, 'Neo 2');
  assert.strictEqual(g.playerCount, 2);
});

test('движение: игрок двигается по вводу и ограничен границами', () => {
  const g = new Game();
  const { player } = g.join('Mover');
  g.setInput(player.id, { right: true, seq: 1, aimX: 0, aimY: 0 });
  const x0 = player.x;
  g.update();
  assert.ok(player.x > x0, 'игрок должен двигаться вправо');

  for (let i = 0; i < 600; i++) {
    g.setInput(player.id, { right: true, seq: i + 2 });
    g.update();
  }
  assert.ok(player.x <= C.WORLD.w - C.PLAYER_R + 0.001, 'не выходит за правую границу');
});

test('бой: снаряд наносит урон и убийство даёт очки', () => {
  const g = new Game();
  const a = g.join('Attacker').player;
  const v = g.join('Victim').player;

  a.x = 100;
  a.y = 100;
  v.x = 200;
  v.y = 100;

  let killEv = null;
  for (let i = 0; i < 120 && !v.dead; i++) {
    g.setInput(a.id, { fire: true, aimX: v.x, aimY: v.y, seq: i + 1 });
    g.update();
    const evs = g.drainEvents().filter((e) => e.k === 'kill');
    if (evs.length) killEv = evs[0];
  }

  assert.ok(v.dead, 'жертва должна умереть');
  assert.strictEqual(v.deaths, 1);
  assert.ok(a.kills >= 1);
  assert.ok(a.score >= C.KILL_BONUS);
  assert.ok(killEv && killEv.attacker === a.id);
  assert.ok(v.respawnAt > g.tick);
});

test('респаун: через RESPAWN_TICKS игрок снова жив', () => {
  const g = new Game();
  const p = g.join('Phoenix').player;
  p.hp = 1;
  p.dead = true;
  p.respawnAt = g.tick + C.RESPAWN_TICKS;
  for (let i = 0; i < C.RESPAWN_TICKS + 2; i++) g.update();
  assert.strictEqual(p.dead, false);
  assert.strictEqual(p.hp, C.PLAYER_HP);
});

test('орбы: подбор увеличивает очки, количество восстанавливается', () => {
  const g = new Game();
  const p = g.join('Hungry').player;
  const orb = g.orbs.values().next().value;
  p.x = orb.x;
  p.y = orb.y;
  const score0 = p.score;
  g.update();
  assert.strictEqual(p.score, score0 + C.ORB_VALUE);
  assert.strictEqual(g.orbs.size, C.ORB_TARGET, 'орбы доливаются до целевого числа');
});

test('персистентность: serialize -> восстановление профиля при перезапуске', () => {
  const g1 = new Game();
  const p = g1.join('Keeper').player;
  p.score = 123;
  p.kills = 4;
  p.deaths = 2;
  const data = JSON.parse(JSON.stringify(g1.serialize()));

  const g2 = new Game(data);
  const rejoined = g2.join('Keeper').player;
  assert.strictEqual(rejoined.score, 123);
  assert.strictEqual(rejoined.kills, 4);
  assert.strictEqual(rejoined.deaths, 2);
  assert.strictEqual(g2.orbs.size, C.ORB_TARGET);
});

test('лимит игроков', () => {
  const g = new Game();
  for (let i = 0; i < C.MAX_PLAYERS; i++) g.join('P' + i);
  const res = g.join('Extra');
  assert.strictEqual(res.error, 'server_full');
});

test('setInput: устаревшие seq игнорируются', () => {
  const g = new Game();
  const p = g.join('Seq').player;
  assert.strictEqual(g.setInput(p.id, { seq: 10, right: true }), true);
  assert.strictEqual(g.setInput(p.id, { seq: 5, right: false }), false);
  assert.strictEqual(p.input.right, true);
});
