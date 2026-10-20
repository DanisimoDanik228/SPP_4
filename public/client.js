'use strict';

(function () {
  var C = window.CONST;
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');

  var overlay = document.getElementById('overlay');
  var nameInput = document.getElementById('name-input');
  var joinBtn = document.getElementById('join-btn');
  var statusEl = document.getElementById('status');

  var hpBar = document.getElementById('hp-bar');
  var hpVal = document.getElementById('hp-val');
  var scoreVal = document.getElementById('score-val');
  var killsVal = document.getElementById('kills-val');
  var deathsVal = document.getElementById('deaths-val');
  var tickVal = document.getElementById('tick-val');
  var lbList = document.getElementById('lb-list');
  var feedEl = document.getElementById('feed');
  var respawnEl = document.getElementById('respawn');
  var respawnTimer = document.getElementById('respawn-timer');

  var ws = null;
  var myId = null;
  var joined = false;
  var world = C.WORLD;

  var keys = Object.create(null);
  var mouse = { x: world.w / 2, y: world.h / 2, down: false };

  var snapshots = [];
  var latestSnap = null;
  var eventsQueue = [];
  var lastRenderTime = 0;

  var me = null;
  var pendingInputs = [];
  var inputSeq = 0;
  var lastSend = 0;

  var scale = 1;
  var offsetX = 0;
  var offsetY = 0;

  function resize() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.min(w / world.w, h / world.h);
    offsetX = (w - world.w * scale) / 2;
    offsetY = (h - world.h * scale) / 2;
  }
  window.addEventListener('resize', resize);
  resize();

  function screenToWorld(sx, sy) {
    return { x: (sx - offsetX) / scale, y: (sy - offsetY) / scale };
  }

  window.addEventListener('mousemove', function (e) {
    var p = screenToWorld(e.clientX, e.clientY);
    mouse.x = p.x;
    mouse.y = p.y;
  });
  window.addEventListener('mousedown', function (e) {
    if (e.button === 0) mouse.down = true;
  });
  window.addEventListener('mouseup', function (e) {
    if (e.button === 0) mouse.down = false;
  });
  window.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    keys[e.code] = false;
  });
  window.addEventListener('blur', function () {
    keys = Object.create(null);
    mouse.down = false;
  });

  function currentInput() {
    return {
      up: !!(keys.KeyW || keys.ArrowUp),
      down: !!(keys.KeyS || keys.ArrowDown),
      left: !!(keys.KeyA || keys.ArrowLeft),
      right: !!(keys.KeyD || keys.ArrowRight),
      fire: mouse.down || !!keys.Space,
      aimX: Math.round(mouse.x),
      aimY: Math.round(mouse.y)
    };
  }

  function applyMovement(p, inp, dt) {
    var dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    var dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    if (dx === 0 && dy === 0) return;
    var len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    p.x = Math.min(world.w - C.PLAYER_R, Math.max(C.PLAYER_R, p.x + dx * C.PLAYER_SPEED * dt));
    p.y = Math.min(world.h - C.PLAYER_R, Math.max(C.PLAYER_R, p.y + dy * C.PLAYER_SPEED * dt));
    p.dirX = dx;
    p.dirY = dy;
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');

    ws.onopen = function () {
      statusEl.textContent = 'Подключено. Входим на арену…';
    };

    ws.onclose = function () {
      if (joined) {
        statusEl.textContent = 'Соединение потеряно. Обновите страницу.';
        overlay.classList.remove('hidden');
      } else {
        statusEl.textContent = 'Не удалось подключиться. Обновите страницу.';
      }
    };

    ws.onerror = function () {
      statusEl.textContent = 'Ошибка соединения.';
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case 'welcome': {
        myId = msg.id;
        world = msg.world;
        me = {
          id: msg.id,
          name: msg.name,
          x: msg.you.x,
          y: msg.you.y,
          hp: msg.you.hp,
          score: msg.you.score,
          kills: msg.you.kills,
          deaths: msg.you.deaths,
          dead: false,
          dirX: 1,
          dirY: 0
        };
        joined = true;
        pendingInputs = [];
        inputSeq = 0;
        overlay.classList.add('hidden');
        resize();
        addFeedEvent({ k: 'sys', name: msg.name, text: msg.resumed ? 'с возвращением! Прогресс восстановлен' : 'вошёл на арену' });
        break;
      }
      case 'error': {
        statusEl.textContent = msg.code === 'server_full' ? 'Арена заполнена (макс. ' + C.MAX_PLAYERS + ' игроков).' : 'Ошибка: ' + msg.code;
        break;
      }
      case 'snapshot': {
        var now = performance.now();
        msg.recvAt = now;
        snapshots.push(msg);
        if (snapshots.length > 40) snapshots.shift();
        latestSnap = msg;
        if (msg.events) {
          for (var i = 0; i < msg.events.length; i++) eventsQueue.push(msg.events[i]);
          if (eventsQueue.length > 30) eventsQueue.splice(0, eventsQueue.length - 30);
        }
        reconcile(msg.snap);
        break;
      }
    }
  }

  function reconcile(snap) {
    if (!me) return;
    var serverMe = null;
    for (var i = 0; i < snap.players.length; i++) {
      if (snap.players[i].id === myId) {
        serverMe = snap.players[i];
        break;
      }
    }
    if (!serverMe) return;

    me.dead = serverMe.dead;
    me.respawnIn = serverMe.respawnIn;
    me.hp = serverMe.hp;
    me.score = serverMe.score;
    me.kills = serverMe.kills;
    me.deaths = serverMe.deaths;
    me.name = serverMe.name;

    me.x = serverMe.x;
    me.y = serverMe.y;

    var kept = [];
    var dt = C.TICK_MS / 1000;
    for (var j = 0; j < pendingInputs.length; j++) {
      if (pendingInputs[j].seq > serverMe.seq) {
        applyMovement(me, pendingInputs[j], dt);
        kept.push(pendingInputs[j]);
      }
    }
    pendingInputs = kept;
  }

  function sendInput() {
    if (!ws || ws.readyState !== 1 || !joined || !me || me.dead) return;
    var now = performance.now();
    if (now - lastSend < C.TICK_MS - 1) return;
    lastSend = now;

    var inp = currentInput();
    inp.t = 'input';
    inp.seq = ++inputSeq;
    pendingInputs.push(inp);
    if (pendingInputs.length > 120) pendingInputs.shift();

    applyMovement(me, inp, C.TICK_MS / 1000);

    try {
      ws.send(JSON.stringify(inp));
    } catch (e) {}
  }

  function sampleWorld(renderTime) {
    if (snapshots.length === 0) return null;
    var a = null;
    var b = null;
    for (var i = 0; i < snapshots.length; i++) {
      if (snapshots[i].recvAt <= renderTime) a = snapshots[i];
      else {
        b = snapshots[i];
        break;
      }
    }
    if (!a && b) a = b;
    if (!a) a = snapshots[0];
    if (!b) b = a;
    var span = b.recvAt - a.recvAt;
    var t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.recvAt) / span)) : 1;
    return { a: a, b: b, t: t };
  }

  function lerpPlayers(sample) {
    var aMap = Object.create(null);
    for (var i = 0; i < sample.a.snap.players.length; i++) {
      aMap[sample.a.snap.players[i].id] = sample.a.snap.players[i];
    }
    var out = [];
    var list = sample.b.snap.players;
    for (var j = 0; j < list.length; j++) {
      var pb = list[j];
      var pa = aMap[pb.id];
      if (!pa) {
        out.push(pb);
        continue;
      }
      out.push({
        id: pb.id,
        name: pb.name,
        color: pb.color,
        x: pa.x + (pb.x - pa.x) * sample.t,
        y: pa.y + (pb.y - pa.y) * sample.t,
        hp: pb.hp,
        score: pb.score,
        kills: pb.kills,
        deaths: pb.deaths,
        dead: pb.dead,
        aimX: pb.aimX,
        aimY: pb.aimY,
        dirX: pb.dirX,
        dirY: pb.dirY
      });
    }
    return out;
  }

  function draw(now) {
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    ctx.fillStyle = '#111114';
    ctx.fillRect(0, 0, world.w, world.h);

    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (var gx = 100; gx < world.w; gx += 100) {
      for (var gy = 100; gy < world.h; gy += 100) {
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, world.w - 1, world.h - 1);

    var sample = sampleWorld(now - C.INTERP_DELAY);
    if (!sample) {
      ctx.restore();
      return;
    }

    var orbs = sample.b.snap.orbs;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (var o = 0; o < orbs.length; o++) {
      ctx.beginPath();
      ctx.arc(orbs[o].x, orbs[o].y, C.ORB_R, 0, Math.PI * 2);
      ctx.fill();
    }

    var shots = sample.b.snap.shots;
    ctx.fillStyle = '#ededed';
    for (var s = 0; s < shots.length; s++) {
      ctx.beginPath();
      ctx.arc(shots[s].x, shots[s].y, C.SHOT_R, 0, Math.PI * 2);
      ctx.fill();
    }

    var players = lerpPlayers(sample);
    for (var p = 0; p < players.length; p++) {
      var pl = players[p];
      if (pl.dead) continue;
      if (pl.id === myId && me) {
        drawPlayer(me.x, me.y, me.dirX, me.dirY, me.hp, me.name, me.color || '#ededed', true);
      } else {
        drawPlayer(pl.x, pl.y, pl.dirX, pl.dirY, pl.hp, pl.name, pl.color || '#6b6b70', false);
      }
    }

    ctx.restore();
  }

  function drawPlayer(x, y, dirX, dirY, hp, name, color, isMe) {
    ctx.save();
    ctx.translate(x, y);

    if (isMe) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, C.PLAYER_R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, C.PLAYER_R, 0, Math.PI * 2);
    ctx.fill();

    var ang = Math.atan2(dirY, dirX);
    ctx.rotate(ang);
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(C.PLAYER_R - 6, -2, 12, 4);
    ctx.rotate(-ang);

    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(-24, -C.PLAYER_R - 12, 48, 2);
    ctx.fillStyle = color;
    ctx.fillRect(-24, -C.PLAYER_R - 12, 48 * Math.max(0, Math.min(1, hp / 100)), 2);

    ctx.fillStyle = color;
    ctx.font = (isMe ? '600 ' : '') + '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name, 0, -C.PLAYER_R - 18);
    ctx.restore();
  }

  function updateHud() {
    if (!me) return;
    hpBar.style.width = Math.max(0, me.hp) + '%';
    hpVal.textContent = Math.max(0, me.hp);
    scoreVal.textContent = me.score;
    killsVal.textContent = me.kills;
    deathsVal.textContent = me.deaths;
    tickVal.textContent = latestSnap ? latestSnap.snap.tick : 0;

    if (me.dead) {
      respawnEl.classList.remove('hidden');
      respawnTimer.textContent = Math.ceil((me.respawnIn || 0) * C.TICK_MS / 1000);
    } else {
      respawnEl.classList.add('hidden');
    }

    if (latestSnap) {
      var list = latestSnap.snap.players.slice().sort(function (a, b) {
        return b.score - a.score || b.kills - a.kills;
      });
      var html = '';
      for (var i = 0; i < Math.min(8, list.length); i++) {
        var p = list[i];
        html += '<li' + (p.id === myId ? ' class="me"' : '') + '><span>' + escapeHtml(p.name) + '</span><b>' + p.score + '</b></li>';
      }
      lbList.innerHTML = html;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function addFeedEvent(ev) {
    var line = document.createElement('div');
    line.className = 'feed-line';
    if (ev.k === 'kill') {
      line.innerHTML = '<span class="a">' + escapeHtml(ev.attackerName) + '</span> уничтожил <span class="b">' + escapeHtml(ev.name) + '</span>';
    } else if (ev.k === 'join') {
      line.innerHTML = '<span class="a">' + escapeHtml(ev.name) + '</span> вошёл на арену';
    } else if (ev.k === 'leave') {
      line.innerHTML = '<span class="a">' + escapeHtml(ev.name) + '</span> покинул арену';
    } else if (ev.k === 'sys') {
      line.innerHTML = '<span class="a">' + escapeHtml(ev.name) + '</span> ' + escapeHtml(ev.text || '');
    } else {
      return;
    }
    feedEl.appendChild(line);
    while (feedEl.children.length > 6) feedEl.removeChild(feedEl.firstChild);
    setTimeout(function () {
      line.style.opacity = '0';
    }, 3500);
    setTimeout(function () {
      if (line.parentNode) line.parentNode.removeChild(line);
    }, 4200);
  }

  function drainFeed() {
    while (eventsQueue.length) {
      var ev = eventsQueue.shift();
      if (ev.k === 'kill' || ev.k === 'join' || ev.k === 'leave') addFeedEvent(ev);
    }
  }

  function loop() {
    var now = performance.now();
    lastRenderTime = now;
    sendInput();
    drainFeed();
    updateHud();
    draw(now);
    requestAnimationFrame(loop);
  }

  function tryJoin() {
    var name = nameInput.value.trim();
    if (!name) {
      statusEl.textContent = 'Введите никнейм.';
      return;
    }
    if (!ws || ws.readyState !== 1) {
      statusEl.textContent = 'Соединение ещё не установлено…';
      return;
    }
    ws.send(JSON.stringify({ t: 'join', name: name }));
    statusEl.textContent = 'Подключение к арене…';
  }

  joinBtn.addEventListener('click', tryJoin);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryJoin();
  });

  connect();
  requestAnimationFrame(loop);
})();
