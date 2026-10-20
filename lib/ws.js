'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request || null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.closeSent = false;
    this.isAlive = true;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this._parseBuffer();
    } catch (err) {
      this.emit('error', err);
      this.close(1002, 'protocol error');
    }
  }

  _parseBuffer() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const rsv = buf[0] & 0x70;
      const opcode = buf[0] & 0x0f;
      if (rsv !== 0) {
        this.close(1002, 'rsv bits unsupported');
        return;
      }

      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) {
          this.close(1009, 'message too big');
          return;
        }
        len = Number(big);
        offset = 10;
      }

      if (len > MAX_PAYLOAD) {
        this.close(1009, 'message too big');
        return;
      }

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = buf.subarray(offset + len);

      this._handleFrame(fin, opcode, payload, masked);
      if (this.closed) return;
    }
  }

  _handleFrame(fin, opcode, payload, masked) {
    switch (opcode) {
      case 0x0: {
        if (this.fragmentOpcode === 0) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        this.fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this._deliver(op, data);
        }
        return;
      }
      case 0x1:
      case 0x2: {
        if (!masked) {
          this.close(1002, 'client frames must be masked');
          return;
        }
        if (this.fragmentOpcode !== 0) {
          this.close(1002, 'unexpected data frame during fragmentation');
          return;
        }
        if (fin) {
          this._deliver(opcode, payload);
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      case 0x8: {
        const code = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.from([0x03, 0xe8]);
        this._sendClose(code);
        this._shutdown();
        return;
      }
      case 0x9:
        this._sendFrame(0xa, payload);
        return;
      case 0xa:
        this.isAlive = true;
        this.emit('pong', payload);
        return;
      default:
        this.close(1002, 'unknown opcode');
    }
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'), false);
    else if (opcode === 0x2) this.emit('message', payload, true);
    else this.close(1002, 'unsupported opcode');
  }

  send(data) {
    if (this.closed) return false;
    const isBuf = Buffer.isBuffer(data);
    const payload = isBuf ? data : Buffer.from(String(data), 'utf8');
    return this._sendFrame(isBuf ? 0x2 : 0x1, payload);
  }

  ping(payload) {
    if (this.closed) return false;
    return this._sendFrame(0x9, payload || Buffer.alloc(0));
  }

  close(code, reason) {
    if (this.closed) return;
    reason = reason || '';
    const r = Buffer.from(reason, 'utf8').subarray(0, 120);
    const buf = Buffer.alloc(2 + r.length);
    buf.writeUInt16BE(code || 1000, 0);
    r.copy(buf, 2);
    this._sendClose(buf);
    this._shutdown();
  }

  _sendClose(payload) {
    if (this.closeSent) return;
    this.closeSent = true;
    this._sendFrame(0x8, payload);
  }

  _shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    const sock = this.socket;
    if (sock.writable) sock.end();
    const timer = setTimeout(() => {
      if (!sock.destroyed) sock.destroy();
    }, 500);
    if (timer.unref) timer.unref();
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _sendFrame(opcode, payload) {
    const sock = this.socket;
    if (this.closed && opcode !== 0x8) return false;
    if (sock.destroyed || !sock.writable) return false;

    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    sock.write(Buffer.concat([header, payload]));
    return true;
  }
}

class WebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this.server = options.server;
    this.path = options.path || '/';
    this.pingInterval = options.pingInterval || 30000;
    this.connections = new Set();
    this._onUpgrade = (req, socket, head) => this._handleUpgrade(req, socket, head);
    this.server.on('upgrade', this._onUpgrade);
    this._heartbeat = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.isAlive) {
          conn.socket.destroy();
          continue;
        }
        conn.isAlive = false;
        conn.ping();
      }
    }, this.pingInterval);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _handleUpgrade(req, socket, head) {
    const url = (req.url || '').split('?')[0];
    if (this.path && url !== this.path) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const version = String(req.headers['sec-websocket-version'] || '');
    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    const conn = new WSConnection(socket, req);
    this.connections.add(conn);
    conn.on('pong', () => {});
    conn.on('close', () => this.connections.delete(conn));
    if (head && head.length) conn._onData(head);
    this.emit('connection', conn, req);
  }

  broadcast(data) {
    for (const conn of this.connections) conn.send(data);
  }

  get clientCount() {
    return this.connections.size;
  }

  close() {
    clearInterval(this._heartbeat);
    this.server.removeListener('upgrade', this._onUpgrade);
    for (const conn of Array.from(this.connections)) conn.close(1001, 'server shutting down');
  }
}

module.exports = { WebSocketServer, WSConnection, acceptKey };
