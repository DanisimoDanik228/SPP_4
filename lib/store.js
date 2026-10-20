'use strict';

const fs = require('fs');
const path = require('path');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  if (extra === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra;
  const out = Object.assign({}, base);
  for (const key of Object.keys(extra)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(extra[key])
      ? merge(base[key], extra[key])
      : extra[key];
  }
  return out;
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults || {};
    this.data = this._load();
  }

  _load() {
    const base = JSON.parse(JSON.stringify(this.defaults));
    if (!fs.existsSync(this.file)) return base;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      return base;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const backup = this.file + '.corrupt-' + Date.now();
      try {
        fs.renameSync(this.file, backup);
      } catch (_) {}
      return base;
    }
    if (!isPlainObject(parsed)) return base;
    return merge(base, parsed);
  }

  save(data) {
    if (data !== undefined) this.data = data;
    this.data.savedAt = Date.now();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return true;
  }
}

module.exports = { Store, merge };
