'use strict';

const C = require('../shared/constants');

const PALETTE = [
  '#ff5c5c',
  '#ffb84d',
  '#f5e663',
  '#6bd968',
  '#4dc9f6',
  '#7a8cff',
  '#c77dff',
  '#ff7ab6'
];

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\w \-А-Яа-яЁё]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function normalizeInput(msg) {
  return {
    up: !!(msg && msg.up),
    down: !!(msg && msg.down),
    left: !!(msg && msg.left),
    right: !!(msg && msg.right),
    fire: !!(msg && msg.fire),
    aimX: clamp(Number(msg && msg.aimX) || 0, -4000, 4000),
    aimY: clamp(Number(msg && msg.aimY) || 0, -4000, 4000),
    seq: Number(msg && msg.seq) || 0
  };
}

class Game {
  constructor(persisted) {
    this.tick = 0;
    this.nextId = 1;
    this.players = new Map();
    this.shots = new Map();
    this.orbs = new Map();
    this.events = [];
    this.profiles = new Map();

    if (persisted && typeof persisted === 'object') {
      this.tick = Number(persisted.tick) || 0;
      this.nextId = Number(persisted.nextId) || 1;
      if (Array.isArray(persisted.profiles)) {
        for (const p of persisted.profiles) {
          if (p && typeof p.name === 'string') this.profiles.set(p.name, p);
        }
      }
      if (Array.isArray(persisted.orbs)) {
        for (const o of persisted.orbs) {
          if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) {
            const id = this._id();
            this.orbs.set(id, { id, x: o.x, y: o.y });
          }
        }
      }
    }
    this._fillOrbs();
  }

  _id() {
    return this.nextId++;
  }

  _fillOrbs() {
    while (this.orbs.size < C.ORB_TARGET) {
      const id = this._id();
      this.orbs.set(id, { id, x: rand(40, C.WORLD.w - 40), y: rand(40, C.WORLD.h - 40) });
    }
  }

  get playerCount() {
    return this.players.size;
  }

  join(name, connId) {
    if (this.players.size >= C.MAX_PLAYERS) return { error: 'server_full' };
    let clean = sanitizeName(name);
    if (!clean) clean = 'Игрок' + (this.players.size + 1);

    const used = new Set(Array.from(this.players.values()).map((p) => p.name));
    if (used.has(clean)) {
      let i = 2;
      while (used.has(clean + ' ' + i)) i++;
      clean = (clean + ' ' + i).slice(0, 16);
    }

    const profile = this.profiles.get(clean) || null;
    const id = connId || String(this._id());
    const player = {
      id,
      name: clean,
      color: colorFor(clean),
      x: rand(C.PLAYER_R, C.WORLD.w - C.PLAYER_R),
      y: rand(C.PLAYER_R, C.WORLD.h - C.PLAYER_R),
      hp: C.PLAYER_HP,
      score: profile ? profile.score : 0,
      kills: profile ? profile.kills : 0,
      deaths: profile ? profile.deaths : 0,
      dead: false,
      respawnAt: 0,
      aimX: 0,
      aimY: 0,
      input: { up: false, down: false, left: false, right: false, fire: false },
      seq: 0,
      lastShot: -C.SHOT_COOLDOWN_TICKS,
      dirX: 1,
      dirY: 0,
      joinedAt: Date.now()
    };
    this.players.set(id, player);
    this.events.push({ k: 'join', id, name: player.name });
    return { player, resumed: !!profile };
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this._storeProfile(p);
    this.players.delete(id);
    this.events.push({ k: 'leave', id, name: p.name });
  }

  setInput(id, raw) {
    const p = this.players.get(id);
    if (!p) return false;
    const inp = normalizeInput(raw);
    if (inp.seq < p.seq) return false;
    p.seq = inp.seq;
    p.aimX = inp.aimX;
    p.aimY = inp.aimY;
    p.input.up = inp.up;
    p.input.down = inp.down;
    p.input.left = inp.left;
    p.input.right = inp.right;
    p.input.fire = inp.fire;
    return true;
  }

  _storeProfile(p) {
    this.profiles.set(p.name, {
      name: p.name,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      lastSeen: Date.now()
    });
  }

  update() {
    this.tick++;
    const dt = C.TICK_MS / 1000;
    const W = C.WORLD.w;
    const H = C.WORLD.h;

    for (const p of this.players.values()) {
      if (p.dead) {
        if (this.tick >= p.respawnAt) {
          p.dead = false;
          p.hp = C.PLAYER_HP;
          p.x = rand(C.PLAYER_R, W - C.PLAYER_R);
          p.y = rand(C.PLAYER_R, H - C.PLAYER_R);
          this.events.push({ k: 'respawn', id: p.id, name: p.name });
        }
        continue;
      }

      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        p.dirX = dx;
        p.dirY = dy;
        p.x = clamp(p.x + dx * C.PLAYER_SPEED * dt, C.PLAYER_R, W - C.PLAYER_R);
        p.y = clamp(p.y + dy * C.PLAYER_SPEED * dt, C.PLAYER_R, H - C.PLAYER_R);
      }

      if (p.input.fire && this.tick - p.lastShot >= C.SHOT_COOLDOWN_TICKS) {
        p.lastShot = this.tick;
        let ax = p.aimX - p.x;
        let ay = p.aimY - p.y;
        const al = Math.hypot(ax, ay);
        if (al < 1) {
          ax = p.dirX;
          ay = p.dirY;
        } else {
          ax /= al;
          ay /= al;
        }
        const id = this._id();
        this.shots.set(id, {
          id,
          owner: p.id,
          x: p.x + ax * (C.PLAYER_R + C.SHOT_R + 2),
          y: p.y + ay * (C.PLAYER_R + C.SHOT_R + 2),
          vx: ax * C.SHOT_SPEED,
          vy: ay * C.SHOT_SPEED,
          ttl: C.SHOT_TTL_TICKS
        });
      }
    }

    const deadShots = [];
    for (const s of this.shots.values()) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.ttl--;
      if (
        s.ttl <= 0 ||
        s.x < -20 ||
        s.x > W + 20 ||
        s.y < -20 ||
        s.y > H + 20
      ) {
        deadShots.push(s.id);
        continue;
      }
      for (const p of this.players.values()) {
        if (p.dead || p.id === s.owner) continue;
        const rr = C.PLAYER_R + C.SHOT_R;
        if (dist2(s.x, s.y, p.x, p.y) <= rr * rr) {
          this._hit(p, s.owner);
          deadShots.push(s.id);
          break;
        }
      }
    }
    for (const id of deadShots) this.shots.delete(id);

    for (const o of Array.from(this.orbs.values())) {
      let taken = false;
      for (const p of this.players.values()) {
        if (p.dead) continue;
        const rr = C.PLAYER_R + C.ORB_R;
        if (dist2(o.x, o.y, p.x, p.y) <= rr * rr) {
          p.score += C.ORB_VALUE;
          this.orbs.delete(o.id);
          this.events.push({ k: 'orb', id: p.id, name: p.name, value: C.ORB_VALUE });
          taken = true;
          break;
        }
      }
      if (taken) break;
    }
    this._fillOrbs();
  }

  _hit(victim, attackerId) {
    victim.hp -= C.SHOT_DMG;
    if (victim.hp > 0) {
      this.events.push({ k: 'hit', id: victim.id, attacker: attackerId });
      return;
    }
    victim.hp = 0;
    victim.dead = true;
    victim.respawnAt = this.tick + C.RESPAWN_TICKS;
    victim.deaths++;
    victim.input.up = false;
    victim.input.down = false;
    victim.input.left = false;
    victim.input.right = false;
    victim.input.fire = false;
    const attacker = this.players.get(attackerId);
    if (attacker && attacker.id !== victim.id) {
      attacker.kills++;
      attacker.score += C.KILL_BONUS;
    }
    this.events.push({
      k: 'kill',
      id: victim.id,
      name: victim.name,
      attacker: attackerId,
      attackerName: attacker ? attacker.name : '—'
    });
  }

  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        hp: p.hp,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        dead: p.dead,
        respawnIn: p.dead ? Math.max(0, p.respawnAt - this.tick) : 0,
        aimX: p.aimX,
        aimY: p.aimY,
        dirX: Math.round(p.dirX * 100) / 100,
        dirY: Math.round(p.dirY * 100) / 100,
        seq: p.seq
      });
    }
    const shots = [];
    for (const s of this.shots.values()) {
      shots.push({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), owner: s.owner });
    }
    const orbs = [];
    for (const o of this.orbs.values()) orbs.push({ id: o.id, x: Math.round(o.x), y: Math.round(o.y) });
    return { tick: this.tick, players, shots, orbs };
  }

  drainEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  serialize() {
    for (const p of this.players.values()) this._storeProfile(p);
    return {
      tick: this.tick,
      nextId: this.nextId,
      profiles: Array.from(this.profiles.values()),
      orbs: Array.from(this.orbs.values()).map((o) => ({ x: Math.round(o.x), y: Math.round(o.y) })),
      savedAt: Date.now()
    };
  }
}

module.exports = { Game, sanitizeName, normalizeInput, clamp };
