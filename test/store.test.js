'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, merge } = require('../lib/store');

test('merge: deep merge без мутации', () => {
  const base = { a: 1, nested: { x: 1, y: 2 } };
  const out = merge(base, { nested: { y: 5 }, b: 2 });
  assert.deepStrictEqual(out, { a: 1, nested: { x: 1, y: 5 }, b: 2 });
  assert.deepStrictEqual(base, { a: 1, nested: { x: 1, y: 2 } });
});

test('Store: сохранение и загрузка между запусками', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-store-'));
  const file = path.join(dir, 'save.json');

  const s1 = new Store(file, { tick: 0, profiles: [] });
  s1.data.tick = 42;
  s1.data.profiles.push({ name: 'Tester', score: 100 });
  s1.save();

  const s2 = new Store(file, { tick: 0, profiles: [] });
  assert.strictEqual(s2.data.tick, 42);
  assert.deepStrictEqual(s2.data.profiles, [{ name: 'Tester', score: 100 }]);
  assert.ok(s2.data.savedAt > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Store: повреждённый файл не роняет приложение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-store-'));
  const file = path.join(dir, 'save.json');
  fs.writeFileSync(file, '{ not json !!!', 'utf8');

  const s = new Store(file, { tick: 7 });
  assert.strictEqual(s.data.tick, 7);
  const backups = fs.readdirSync(dir).filter((f) => f.indexOf('.corrupt-') !== -1);
  assert.strictEqual(backups.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Store: отсутствующий файл отдаёт дефолты', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-store-'));
  const s = new Store(path.join(dir, 'missing.json'), { a: 1 });
  assert.deepStrictEqual(s.data, { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});
