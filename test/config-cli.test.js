'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { startProxy, until, wait } = require('./helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'mockwire.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
const cli = (args, base) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args, '--url', base], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

test('config: scenarios, scenario use, hot reload, bad reload keeps old rules', async () => {
  const dir = tmp();
  const cfg = path.join(dir, 'mockwire.json');
  const write = (o) => fs.writeFileSync(cfg, typeof o === 'string' ? o : JSON.stringify(o));
  write({
    rules: [{ name: 'base', path: '/base', text: 'base' }],
    scenarios: {
      broken: { rules: [{ name: 'b500', path: '/s', status: 500 }] },
      empty: { description: 'empty', rules: [{ name: 'e', path: '/s', json: [] }] },
    },
  });
  const P = await startProxy({ config: cfg });
  try {
    let st = (await P.ctl('GET', '/state')).body;
    assert.deepEqual(st.scenarios.sort(), ['broken', 'empty']);
    assert.equal((await fetch(P.base + '/base')).status, 200);
    assert.equal(await (await fetch(P.base + '/base')).text(), 'base');
    assert.equal((await fetch(P.base + '/s')).status, 200); // upstream

    assert.equal((await P.ctl('POST', '/scenarios/broken/use')).status, 200);
    assert.equal((await fetch(P.base + '/s')).status, 500);
    await P.ctl('POST', '/scenarios/empty/use');
    assert.deepEqual(await (await fetch(P.base + '/s')).json(), []);
    const unknown = await P.ctl('POST', '/scenarios/nope/use');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error.message, /available: default, broken, empty/);

    // hot reload: change the empty scenario, active scenario stays
    write({ rules: [], scenarios: { empty: { rules: [{ name: 'e2', path: '/s', json: { n: 1 } }] } } });
    assert.ok(await until(async () => (await (await fetch(P.base + '/s')).text()) === '{"n":1}'));
    st = (await P.ctl('GET', '/state')).body;
    assert.equal(st.scenario, 'empty');
    assert.equal(st.configError, null);

    // invalid reload keeps previous rules and reports the error
    write('{ nope');
    assert.ok(await until(async () => (await P.ctl('GET', '/state')).body.configError));
    assert.deepEqual(await (await fetch(P.base + '/s')).json(), { n: 1 });
    write({ rules: [{ path: '/x' }] });
    assert.ok(await until(async () => /rules\[0\]/.test((await P.ctl('GET', '/state')).body.configError || '')));
    assert.deepEqual(await (await fetch(P.base + '/s')).json(), { n: 1 });
    // recovery
    write({ rules: [], scenarios: { empty: { rules: [{ path: '/s', json: { n: 2 } }] } } });
    assert.ok(await until(async () => (await (await fetch(P.base + '/s')).text()) === '{"n":2}'));
    assert.equal((await P.ctl('GET', '/state')).body.configError, null);
  } finally { await P.close(); }
});

test('config: invalid at startup throws a clear error', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ rules: [{ path: '/x', status: 1000 }] }));
  const { createMockwire } = require('../src/index.js');
  assert.throws(() => createMockwire({ config: cfg, logger: null }), /rules\[0\]: status must be/);
});

test('config: upstream + relative mock file from config', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ranking.json'), '{"items":[1]}');
  const { startUpstream } = require('./helpers.js');
  const up = await startUpstream();
  const cfg = path.join(dir, 'mockwire.json');
  fs.writeFileSync(cfg, JSON.stringify({ upstream: up.url, rules: [{ path: '/api/ranking', file: 'ranking.json' }] }));
  const { createMockwire } = require('../src/index.js');
  const mw = createMockwire({ config: cfg, logger: null });
  const a = await mw.listen(0, '127.0.0.1');
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${a.port}/api/ranking`)).json(), { items: [1] });
    assert.equal((await fetch(`http://127.0.0.1:${a.port}/other`)).status, 200);
  } finally {
    await mw.close();
    up.server.closeAllConnections?.();
    await new Promise((r) => up.server.close(r));
  }
});

test('CLI: rule add/list/rm, offline, scenario, log, reset (all --json)', async () => {
  const dir = tmp();
  const cfg = path.join(dir, 'mockwire.json');
  fs.writeFileSync(cfg, JSON.stringify({ scenarios: { empty: { description: 'x', rules: [{ path: '/api/list', json: [] }] } } }));
  const P = await startProxy({ config: cfg });
  const j = async (args) => {
    const r = await cli([...args, '--json'], P.base);
    return { code: r.code, data: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  try {
    assert.equal((await j(['health'])).data.ok, true);

    let r = await j(['rule', 'add', '--name', 'rk', '--method', 'GET', '--path', '/api/ranking', '--status', '500']);
    assert.equal(r.code, 0);
    assert.equal(r.data.rule.status, 500);
    assert.equal((await fetch(P.base + '/api/ranking')).status, 500);

    r = await j(['rule', 'add', '--path', '/api/q', '--query', 'a=1', '--body-json', '{"x":1}', '--times', '1']);
    assert.deepEqual(r.data.rule.query, { a: '1' });
    assert.deepEqual(await (await fetch(P.base + '/api/q?a=1')).json(), { x: 1 });

    r = await j(['rule', 'add', '--path', '/api/d', '--drop']);
    assert.equal(r.data.rule.action, 'drop');
    await assert.rejects(fetch(P.base + '/api/d'));

    r = await j(['rule', 'add', '--path', '/gzip', '--merge', '{"m":1}', '--set', '$.b.c=7']);
    assert.equal(r.data.rule.action, 'modify');
    assert.deepEqual(r.data.rule.set, { '$.b.c': 7 });

    r = await j(['rule', 'add', '--path', '/bad']);
    assert.equal(r.code, 1);
    assert.match(r.data.error.message, /cannot infer action/);

    r = await j(['rule', 'list']);
    assert.ok(r.data.rules.length >= 4);
    r = await j(['rule', 'disable', 'rk']);
    assert.equal(r.data.rule.enabled, false);
    assert.equal((await fetch(P.base + '/api/ranking')).status, 200);
    r = await j(['rule', 'rm', 'rk']);
    assert.equal(r.code, 0);
    r = await j(['rule', 'rm', 'rk']);
    assert.equal(r.code, 1);

    r = await j(['offline', 'on']);
    assert.equal(r.data.offline, true);
    await assert.rejects(fetch(P.base + '/x'));
    r = await j(['offline', 'off']);
    assert.equal(r.data.offline, false);

    r = await j(['scenario', 'list']);
    assert.equal(r.data.scenarios[0].name, 'empty');
    await j(['rule', 'clear']);
    r = await j(['scenario', 'use', 'empty']);
    assert.equal(r.data.scenario, 'empty');
    assert.deepEqual(await (await fetch(P.base + '/api/list')).json(), []);
    r = await j(['scenario', 'use', 'nope']);
    assert.equal(r.code, 1);

    r = await j(['log', '--tail', '3']);
    assert.equal(r.data.requests.length, 3);
    assert.ok('rule' in r.data.requests[0] && 'ms' in r.data.requests[0]);

    r = await j(['state']);
    assert.equal(r.data.scenario, 'empty');
    r = await j(['reset']);
    assert.equal(r.data.ok, true);

    // human output works too
    const h = await cli(['state'], P.base);
    assert.match(h.stdout, /mockwire \d/);
    // unreachable
    const dead = await cli(['state', '--json'], 'http://127.0.0.1:1');
    assert.equal(dead.code, 2);
    assert.match(JSON.parse(dead.stdout).error.message, /cannot reach mockwire/);
  } finally { await P.close(); }
});

test('CLI: `start` boots a real process, serves, and exits on SIGTERM', async () => {
  const { startUpstream } = require('./helpers.js');
  const up = await startUpstream();
  const child = spawn(process.execPath, [BIN, 'start', '--upstream', up.url, '--port', '0', '--host', '127.0.0.1', '--json'], { cwd: tmp() });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  try {
    assert.ok(await until(() => /"event":"listening"/.test(out), 5000), out);
    const info = JSON.parse(out.split('\n').find((l) => l.includes('listening')));
    const base = `http://127.0.0.1:${info.port}`;
    assert.equal((await fetch(base + '/hi')).status, 200);
    assert.ok(await until(() => /GET \/hi -> 200/.test(out)));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    up.server.closeAllConnections?.();
    await new Promise((r) => up.server.close(r));
  }
});

test('CLI: init writes a valid example config that loads', async () => {
  const dir = tmp();
  await new Promise((r) => execFile(process.execPath, [BIN, 'init'], { cwd: dir }, r));
  const { createMockwire } = require('../src/index.js');
  const mw = createMockwire({ config: path.join(dir, 'mockwire.json'), logger: null });
  assert.deepEqual(Object.keys(mw.state.scenarios).sort(), ['empty', 'flaky', 'server_error', 'slow']);
  await mw.close();
});
