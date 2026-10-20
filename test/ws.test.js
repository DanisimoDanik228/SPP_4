'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { WebSocketServer } = require('../lib/ws');
const { RawClient } = require('./wsclient');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('WS: рукопожатие, текстовые сообщения, ping/pong', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws', pingInterval: 60000 });
  const received = [];
  wss.on('connection', (conn) => {
    conn.on('message', (msg) => {
      received.push(msg);
      conn.send('echo:' + msg);
    });
  });

  const port = await listen(server);
  const client = new RawClient(port);
  await client.connect();

  client.send({ hello: 'world' });
  const reply = await client.waitFor((m) => m.indexOf('echo:') === 0);
  assert.deepStrictEqual(JSON.parse(reply.slice(5)), { hello: 'world' });
  assert.strictEqual(received.length, 1);

  client.ping();
  await new Promise((r) => setTimeout(r, 50));

  client.close();
  await new Promise((r) => setTimeout(r, 50));
  wss.close();
  await new Promise((r) => server.close(r));
});

test('WS: некорректный путь отклоняется', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws', pingInterval: 60000 });
  const port = await listen(server);

  const net = require('net');
  const result = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.write(
        'GET /other HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    socket.on('data', (d) => resolve(d.toString('utf8')));
    socket.on('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 2000);
  });

  assert.ok(result.indexOf('101') === -1, 'не должно быть 101');
  wss.close();
  await new Promise((r) => server.close(r));
});

test('WS: фрагментированные кадры собираются', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws', pingInterval: 60000 });
  let got = null;
  wss.on('connection', (conn) => {
    conn.on('message', (msg) => {
      got = msg;
    });
  });
  const port = await listen(server);
  const client = new RawClient(port);
  await client.connect();

  const crypto = require('crypto');
  const mask = crypto.randomBytes(4);
  const part1 = Buffer.from('{"t":"jo');
  const part2 = Buffer.from('in","name":"X"}');
  const frame = (fin, payload) => {
    const header = Buffer.alloc(2);
    header[0] = (fin ? 0x80 : 0x00) | 0x1;
    header[1] = 0x80 | payload.length;
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  };
  client.socket.write(Buffer.concat([frame(false, part1), (() => {
    const header = Buffer.alloc(2);
    header[0] = 0x80 | 0x0;
    header[1] = 0x80 | part2.length;
    const masked = Buffer.alloc(part2.length);
    for (let i = 0; i < part2.length; i++) masked[i] = part2[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  })()]));

  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(got, '{"t":"join","name":"X"}');

  client.close();
  await new Promise((r) => setTimeout(r, 50));
  wss.close();
  await new Promise((r) => server.close(r));
});
