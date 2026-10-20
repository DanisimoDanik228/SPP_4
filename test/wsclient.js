'use strict';

const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class RawClient {
  constructor(port, host) {
    this.port = port;
    this.host = host || '127.0.0.1';
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.closeCode = null;
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      this.socket = socket;
      const key = crypto.randomBytes(16).toString('base64');
      let handshaken = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timeout'));
      }, timeoutMs || 5000);

      socket.on('connect', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: ' + this.host + ':' + this.port + '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + key + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!handshaken) {
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = this.buffer.subarray(0, idx).toString('utf8');
          this.buffer = this.buffer.subarray(idx + 4);
          const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
          if (head.indexOf('101') === -1 || head.indexOf(accept) === -1) {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
            return;
          }
          handshaken = true;
          clearTimeout(timer);
          resolve();
        }
        this._parse();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        if (!handshaken) reject(err);
      });

      socket.on('close', () => {
        this.closed = true;
        for (const w of this.waiters.splice(0)) {
          w.reject(new Error('socket closed'));
        }
      });
    });
  }

  _parse() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      const payload = buf.subarray(offset, offset + len);
      const opcode = buf[0] & 0x0f;
      this.buffer = buf.subarray(offset + len);
      if (opcode === 0x1) {
        const msg = payload.toString('utf8');
        this.messages.push(msg);
        for (const w of this.waiters.splice(0)) w.resolve();
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      } else if (opcode === 0x8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.closed = true;
        this.socket.end();
        for (const w of this.waiters.splice(0)) w.reject(new Error('closed by peer'));
      }
    }
  }

  _sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj) {
    this._sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  sendRaw(str) {
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  waitFor(predicate, timeoutMs) {
    const existing = this.messages.find(predicate);
    if (existing) {
      let value = existing;
      try {
        value = JSON.parse(existing);
      } catch (e) {}
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + (timeoutMs || 5000);
      const check = () => {
        const found = this.messages.find(predicate);
        if (found) {
          clearInterval(iv);
          let value = found;
          try {
            value = JSON.parse(found);
          } catch (e) {}
          resolve(value);
          return;
        }
        if (Date.now() > deadline || this.closed) {
          clearInterval(iv);
          reject(new Error('waitFor timeout'));
        }
      };
      const iv = setInterval(check, 10);
    });
  }

  close() {
    if (this.socket && !this.closed) {
      try {
        this._sendFrame(0x8, Buffer.alloc(0));
      } catch (e) {}
      this.socket.end();
    }
  }
}

module.exports = { RawClient };
