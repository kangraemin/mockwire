'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startProxy, wait, until } = require('./helpers.js');

let P;
before(async () => { P = await startProxy(); });
after(async () => { await P.close(); });
test.beforeEach(async () => { await P.ctl('POST', '/reset'); });

const get = (p, init) => fetch(P.base + p, init);

test('passthrough: path, query, host rewrite, headers, POST body', async () => {
  const r = await get('/api/x?y=1', { method: 'POST', body: 'hello', headers: { 'x-custom': 'abc' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-up'), 'yes');
  const j = await r.json();
  assert.equal(j.url, '/api/x?y=1');
  assert.equal(j.body, 'hello');
  assert.equal(j.headers['x-custom'], 'abc');
  assert.equal(j.host, P.up.url.replace('http://', ''));
});

test('passthrough: gzip stays transparent', async () => {
  const r = await get('/gzip');
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(await r.json(), { a: 1, b: { c: 2 }, list: [1, 2, 3] });
});

test('mock: json / text / headers / file', async () => {
  await P.ctl('POST', '/rules', { method: 'GET', path: '/m/json', json: { ok: 1 }, status: 201, headers: { 'x-foo': 'bar' } });
  await P.ctl('POST', '/rules', { path: '/m/text', text: 'hi' });
  const f = path.join(os.tmpdir(), `mw-${process.pid}.json`);
  fs.writeFileSync(f, '{"from":"file"}');
  const add = await P.ctl('POST', '/rules', { path: '/m/file', file: f });
  assert.equal(add.status, 201);
  let r = await get('/m/json');
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('x-foo'), 'bar');
  assert.equal(r.headers.get('x-mockwire-rule') !== null, true);
  assert.deepEqual(await r.json(), { ok: 1 });
  r = await get('/m/text');
  assert.equal(await r.text(), 'hi');
  r = await get('/m/file');
  assert.deepEqual(await r.json(), { from: 'file' });
  assert.match(r.headers.get('content-type'), /json/);
  fs.unlinkSync(f);
});

test('status: 500 default body and custom body', async () => {
  await P.ctl('POST', '/rules', { path: '/e/500', status: 500 });
  await P.ctl('POST', '/rules', { path: '/e/503', action: 'status', status: 503, json: { message: 'down' } });
  let r = await get('/e/500');
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error.code, 'mockwire_injected');
  r = await get('/e/503');
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { message: 'down' });
});

test('delay + passthrough', async () => {
  await P.ctl('POST', '/rules', { path: '/slow', delay: 250 });
  const t = Date.now();
  const r = await get('/slow');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).from, 'upstream');
  assert.ok(Date.now() - t >= 240);
});

test('drop: connection is destroyed', async () => {
  await P.ctl('POST', '/rules', { path: '/drop', action: 'drop' });
  await assert.rejects(get('/drop'));
  const log = (await P.ctl('GET', '/log?tail=1')).body.requests[0];
  assert.equal(log.outcome, 'dropped');
});

test('timeout: hangs until client gives up', async () => {
  await P.ctl('POST', '/rules', { path: '/hang', action: 'timeout' });
  await assert.rejects(get('/hang', { signal: AbortSignal.timeout(300) }));
  assert.ok(await until(async () => (await P.ctl('GET', '/log?tail=1')).body.requests[0]?.outcome === 'timeout'));
});

test('offline: every request fails, then recovers', async () => {
  assert.equal((await P.ctl('PUT', '/offline', { on: true })).body.offline, true);
  await assert.rejects(get('/anything'));
  assert.equal((await P.ctl('GET', '/state')).body.offline, true); // control still works
  await P.ctl('PUT', '/offline/off');
  assert.equal((await get('/anything')).status, 200);
});

test('modify: merge + set + remove on gzip upstream json', async () => {
  await P.ctl('POST', '/rules', { path: '/gzip', merge: { added: true }, set: { '$.b.c': 99, '$.list[1]': 'x' }, remove: ['$.a'] });
  const r = await get('/gzip');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { b: { c: 99 }, list: [1, 'x', 3], added: true });
});

test('modify: status override', async () => {
  await P.ctl('POST', '/rules', { path: '/json', action: 'modify', status: 206, merge: { z: 1 } });
  const r = await get('/json');
  assert.equal(r.status, 206);
  assert.equal((await r.json()).z, 1);
});

test('matching: method, glob, :param, regex, query, header, body', async () => {
  await P.ctl('POST', '/rules', [
    { name: 'm1', method: 'POST', path: '/mt/a', text: 'post-only' },
    { name: 'm2', path: '/mt/users/:id', text: 'param' },
    { name: 'm3', path: '/mt/g/**', text: 'glob' },
    { name: 'm4', path: 're:^/mt/r\\d+$', text: 'regex' },
    { name: 'm5', path: '/mt/q', query: { k: 'v' }, text: 'query' },
    { name: 'm6', path: '/mt/h', header: { 'x-flag': 'on' }, text: 'header' },
    { name: 'm7', path: '/mt/b', bodyContains: 'needle', text: 'body' },
  ]);
  const t = async (p, init) => (await get(p, init)).text();
  assert.equal(await t('/mt/a', { method: 'POST' }), 'post-only');
  assert.notEqual(await t('/mt/a'), 'post-only');
  assert.equal(await t('/mt/users/42'), 'param');
  assert.equal(await t('/mt/g/x/y'), 'glob');
  assert.equal(await t('/mt/r123'), 'regex');
  assert.notEqual(await t('/mt/rx'), 'regex');
  assert.equal(await t('/mt/q?k=v'), 'query');
  assert.notEqual(await t('/mt/q?k=z'), 'query');
  assert.equal(await t('/mt/h', { headers: { 'x-flag': 'on' } }), 'header');
  assert.notEqual(await t('/mt/h'), 'header');
  assert.equal(await t('/mt/b', { method: 'POST', body: 'a needle b' }), 'body');
  assert.notEqual(await t('/mt/b', { method: 'POST', body: 'nothing' }), 'body');
});

test('first match wins; newest runtime rule is first; position=last appends', async () => {
  await P.ctl('POST', '/rules', { path: '/o', text: 'A' });
  await P.ctl('POST', '/rules', { path: '/o', text: 'B' });
  assert.equal(await (await get('/o')).text(), 'B');
  await P.ctl('DELETE', '/rules');
  await P.ctl('POST', '/rules', { path: '/o', text: 'A' });
  await P.ctl('POST', '/rules?position=last', { path: '/o', text: 'B' });
  assert.equal(await (await get('/o')).text(), 'A');
});

test('times, probability, enabled', async () => {
  await P.ctl('POST', '/rules', { name: 'once', path: '/t', status: 500, times: 2 });
  assert.equal((await get('/t')).status, 500);
  assert.equal((await get('/t')).status, 500);
  assert.equal((await get('/t')).status, 200);
  const rule = (await P.ctl('GET', '/rules/once')).body.rule;
  assert.equal(rule.remaining, 0);

  await P.ctl('POST', '/rules', { name: 'never', path: '/p0', status: 500, probability: 0 });
  await P.ctl('POST', '/rules', { name: 'always', path: '/p1', status: 500, probability: 1 });
  assert.equal((await get('/p0')).status, 200);
  assert.equal((await get('/p1')).status, 500);

  await P.ctl('POST', '/rules', { name: 'off', path: '/en', status: 500, enabled: false });
  assert.equal((await get('/en')).status, 200);
  await P.ctl('PATCH', '/rules/off', { enabled: true });
  assert.equal((await get('/en')).status, 500);
});

test('CORS: preflight handled, origin reflected on responses', async () => {
  const r = await get('/api/x', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(r.headers.get('access-control-allow-headers'), 'authorization');
  const g = await get('/api/x', { headers: { origin: 'http://localhost:3000' } });
  assert.equal(g.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  await P.ctl('POST', '/rules', { path: '/c', status: 500 });
  const m = await get('/c', { headers: { origin: 'http://a.test' } });
  assert.equal(m.headers.get('access-control-allow-origin'), 'http://a.test');
});

test('validation: bad rules return 400 with clear message and do not crash', async () => {
  const cases = [
    [{ path: '/x' }, /cannot infer action/],
    [{ path: '/x', status: 99 }, /status must be/],
    [{ path: 're:(', status: 500 }, /invalid regex/],
    [{ path: '/x', status: 500, bogus: 1 }, /unknown field "bogus"/],
    [{ path: 'nope', status: 500 }, /must start with/],
    [{ path: '/x', status: 500, probability: 2 }, /probability/],
    [{ path: '/x', file: '/no/such/file' }, /file not found/],
    [{ path: '/x', json: 1, text: 'a' }, /only one of/],
    [{ path: '/x', action: 'explode' }, /unknown action/],
    [{ path: '/x', set: { '$.': 1 } }, /JSON path/],
  ];
  for (const [rule, re] of cases) {
    const r = await P.ctl('POST', '/rules', rule);
    assert.equal(r.status, 400, JSON.stringify(rule));
    assert.match(r.body.error.message, re);
  }
  const bad = await fetch(P.base + '/__mockwire/rules', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await P.ctl('GET', '/rules')).body.rules.length, 0);
  assert.equal((await get('/still-alive')).status, 200);
});

test('control API: state, rules CRUD, log, reset', async () => {
  const add = await P.ctl('POST', '/rules', { name: 'r500', method: 'GET', path: '/api/ranking', status: 500 });
  assert.equal(add.status, 201);
  const id = add.body.rule.id;
  let st = (await P.ctl('GET', '/state')).body;
  assert.equal(st.rules.length, 1);
  assert.equal(st.rules[0].name, 'r500');
  await get('/api/ranking');
  await get('/other');
  const log = (await P.ctl('GET', '/log?tail=5')).body.requests;
  assert.equal(log.length, 2);
  assert.equal(log[0].rule, 'r500');
  assert.equal(log[0].status, 500);
  assert.equal(log[1].rule, null);
  assert.equal(log[1].action, 'passthrough');
  assert.equal(typeof log[0].ms, 'number');
  assert.equal((await P.ctl('DELETE', `/rules/${id}`)).status, 200);
  assert.equal((await P.ctl('DELETE', `/rules/${id}`)).status, 404);
  await P.ctl('POST', '/rules', { path: '/z', status: 500 });
  await P.ctl('PUT', '/offline/on');
  await P.ctl('POST', '/reset');
  st = (await P.ctl('GET', '/state')).body;
  assert.equal(st.rules.length, 0);
  assert.equal(st.offline, false);
  assert.equal((await P.ctl('GET', '/nope')).status, 404);
});

test('no upstream: unmatched -> 502 json, mocks still work', async () => {
  const Q = await startProxy({ noUpstream: true });
  try {
    await Q.ctl('POST', '/rules', { path: '/a', json: { ok: true } });
    assert.deepEqual(await (await fetch(Q.base + '/a')).json(), { ok: true });
    const r = await fetch(Q.base + '/b');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'no_upstream');
  } finally { await Q.close(); }
});

test('upstream unreachable -> 502 json', async () => {
  const mw = require('../src/index.js').createMockwire({ upstreams: ['http://127.0.0.1:1'], logger: null });
  const a = await mw.listen(0, '127.0.0.1');
  const r = await fetch(`http://127.0.0.1:${a.port}/x`);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, 'upstream_error');
  await mw.close();
});

test('multiple upstreams by path prefix', async () => {
  const { startUpstream } = require('./helpers.js');
  const second = await startUpstream();
  const mw = require('../src/index.js').createMockwire({ upstreams: [P.up.url, `other=${second.url}`], logger: null });
  const a = await mw.listen(0, '127.0.0.1');
  const b = `http://127.0.0.1:${a.port}`;
  const j1 = await (await fetch(b + '/p/1')).json();
  const j2 = await (await fetch(b + '/other/p/2?z=1')).json();
  assert.equal(j1.url, '/p/1');
  assert.equal(j2.url, '/p/2?z=1');
  assert.equal(j2.host, second.url.replace('http://', ''));
  await mw.close();
  second.server.closeAllConnections?.();
  await new Promise((r) => second.server.close(r));
});

test('forward proxy: absolute-URL http request and CONNECT tunnel; rules apply to plain http', async () => {
  const via = (target) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.port, method: 'GET', path: target, headers: { host: new URL(target).host } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
  const direct = `${P.up.url}/fwd?a=1`;
  const r = await via(direct);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).url, '/fwd?a=1');
  await P.ctl('POST', '/rules', { path: '/fwd', status: 418 });
  assert.equal((await via(direct)).status, 418);
  await P.ctl('DELETE', '/rules');

  // CONNECT tunnel to upstream (raw bytes)
  const upPort = new URL(P.up.url).port;
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.port, method: 'CONNECT', path: `127.0.0.1:${upPort}` });
    req.on('connect', (res, socket) => {
      assert.equal(res.statusCode, 200);
      socket.write('GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      let d = '';
      socket.on('data', (c) => (d += c));
      socket.on('end', () => resolve(d));
      socket.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(body, /"url":"\/tunnel"/);
  // offline kills tunnels too
  await P.ctl('PUT', '/offline/on');
  await assert.rejects(new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.port, method: 'CONNECT', path: `127.0.0.1:${upPort}` });
    req.on('connect', resolve);
    req.on('error', reject);
    req.end();
  }));
});

test('log line is one line per request on stdout logger', async () => {
  const lines = [];
  const Q = await startProxy({ logger: (l) => lines.push(l) });
  try {
    await fetch(Q.base + '/hello');
    assert.ok(await until(() => lines.length >= 1));
    assert.equal(lines[0].includes('\n'), false);
    assert.match(lines[0], /GET \/hello -> 200 passthrough/);
  } finally { await Q.close(); }
});
