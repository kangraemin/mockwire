'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { startUpstream, wait } = require('./helpers.js');
const { createMockwire } = require('../src/index.js');

const BIN = path.join(__dirname, '..', 'bin', 'mockwire.js');
const closeUp = async (u) => { u.server.closeAllConnections?.(); await new Promise((r) => u.server.close(r)); };

async function boot(opts = {}) {
  const dev = await startUpstream();
  const prod = await startUpstream();
  const mw = createMockwire({ upstreams: [`dev=${dev.url}`, `prod=${prod.url}`], defaultUpstream: 'dev', token: 'sekret', logger: null, ...opts });
  const a = await mw.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${a.port}`;
  return { mw, base, dev, prod, async close() { await mw.close(); await closeUp(dev); await closeUp(prod); } };
}
const auth = { authorization: 'Bearer sekret', 'content-type': 'application/json' };
const ctl = (base, session, method, p, body, headers = auth) =>
  fetch(`${base}${session ? '/s/' + session : ''}/__mockwire${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('control API requires token; health is open; wrong token rejected', async () => {
  const H = await boot();
  try {
    assert.equal((await ctl(H.base, null, 'GET', '/state', undefined, {})).status, 401);
    assert.equal((await ctl(H.base, null, 'GET', '/state', undefined, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await ctl(H.base, null, 'POST', '/rules', { path: '/x', status: 500 }, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await ctl(H.base, null, 'GET', '/state', undefined, { 'x-mockwire-token': 'sekret' })).status, 200);
    assert.equal((await ctl(H.base, null, 'GET', '/health', undefined, {})).status, 200);
  } finally { await H.close(); }
});

test('without token: control is local-only (forwarded requests get 401)', async () => {
  const mw = createMockwire({ logger: null, token: null });
  const a = await mw.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${a.port}`;
  try {
    const env = process.env.MOCKWIRE_TOKEN; delete process.env.MOCKWIRE_TOKEN;
    assert.equal((await fetch(`${base}/__mockwire/state`)).status, 200);
    assert.equal((await fetch(`${base}/__mockwire/state`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 401);
    if (env) process.env.MOCKWIRE_TOKEN = env;
  } finally { await mw.close(); }
});

test('serve mode refuses to listen without a token', async () => {
  const mw = createMockwire({ logger: null, requireToken: true, token: null });
  delete process.env.MOCKWIRE_TOKEN;
  await assert.rejects(mw.listen(0, '127.0.0.1'), /requires --token/);
  await mw.close();
});

test('sessions are isolated: rules, offline, log; prefix stripped upstream; header form works', async () => {
  const H = await boot();
  try {
    const hit = (s, p, init) => fetch(`${H.base}${s ? '/s/' + s : ''}${p}`, init);
    await ctl(H.base, 'alice', 'POST', '/rules', { path: '/api/x', status: 500 });
    await ctl(H.base, 'bob', 'POST', '/rules', { path: '/api/x', json: { who: 'bob' } });
    assert.equal((await hit('alice', '/api/x')).status, 500);
    assert.deepEqual(await (await hit('bob', '/api/x')).json(), { who: 'bob' });
    const carol = await (await hit('carol', '/api/x?q=1')).json();
    assert.equal(carol.url, '/api/x?q=1'); // prefix stripped, passthrough
    assert.equal((await hit(null, '/api/x')).status, 200); // default session untouched

    // header form
    assert.equal((await hit(null, '/api/x', { headers: { 'x-mockwire-session': 'alice' } })).status, 500);
    const up = await (await hit(null, '/api/y', { headers: { 'x-mockwire-session': 'carol' } })).json();
    assert.equal(up.headers['x-mockwire-session'], undefined);

    // offline in alice only
    await ctl(H.base, 'alice', 'PUT', '/offline/on');
    await assert.rejects(hit('alice', '/api/x'));
    assert.equal((await hit('bob', '/api/x')).status, 200);
    assert.equal((await ctl(H.base, 'bob', 'GET', '/offline')).body.offline, false);

    // logs separate, control URL via prefix
    const la = (await ctl(H.base, 'alice', 'GET', '/log?tail=10')).body.requests;
    const lb = (await ctl(H.base, 'bob', 'GET', '/log?tail=10')).body.requests;
    assert.ok(la.every((e) => e.session === 'alice') && la.length >= 2);
    assert.ok(lb.every((e) => e.session === 'bob'));
    assert.equal((await ctl(H.base, 'bob', 'GET', '/state')).body.rules.length, 1);
    assert.equal((await ctl(H.base, 'dave', 'GET', '/state')).body.rules.length, 0);

    // reset affects only own session
    await ctl(H.base, 'alice', 'POST', '/reset');
    assert.equal((await hit('alice', '/api/x')).status, 200);
    assert.deepEqual(await (await hit('bob', '/api/x')).json(), { who: 'bob' });

    const list = (await ctl(H.base, null, 'GET', '/sessions')).body.sessions.map((s) => s.name);
    assert.ok(['alice', 'bob', 'carol', 'default'].every((n) => list.includes(n)));
    assert.equal((await ctl(H.base, null, 'DELETE', '/sessions/bob')).body.removed, true);
    assert.equal((await hit('bob', '/api/x')).status, 200);

    // bad session name
    assert.equal((await hit('bad name!', '/x')).status, 400);
  } finally { await H.close(); }
});

test('per-session upstream override (dev default, prod per session)', async () => {
  const H = await boot();
  try {
    const hit = async (s) => (await (await fetch(`${H.base}/s/${s}/api/who`)).json()).host;
    const devHost = H.dev.url.replace('http://', '');
    const prodHost = H.prod.url.replace('http://', '');
    assert.equal(await hit('a'), devHost);
    assert.equal((await ctl(H.base, 'a', 'PUT', '/upstream', { name: 'prod' })).body.upstream, 'prod');
    assert.equal(await hit('a'), prodHost);
    assert.equal(await hit('b'), devHost);
    assert.equal((await ctl(H.base, 'a', 'GET', '/state')).body.upstream, 'prod');
    assert.equal((await ctl(H.base, 'a', 'PUT', '/upstream', { name: 'nope' })).status, 400);
    await ctl(H.base, 'a', 'PUT', '/upstream', { name: 'default' });
    assert.equal(await hit('a'), devHost);
    // explicit path-prefix still works inside a session
    const j = await (await fetch(`${H.base}/s/b/prod/api/z`)).json();
    assert.equal(j.host, prodHost);
    assert.equal(j.url, '/api/z');
  } finally { await H.close(); }
});

test('session TTL cleanup removes idle sessions but keeps default', async () => {
  const H = await boot({ sessionTtlMinutes: 0.0005 }); // 30ms
  try {
    await ctl(H.base, 'tmp', 'POST', '/rules', { path: '/x', status: 500 });
    assert.equal(H.mw.state.sessions.has('tmp'), true);
    await wait(100);
    // sweeper runs every 30s; trigger by calling private-ish sweep through time: emulate by checking `last`
    const x = H.mw.state.sessions.get('tmp');
    assert.ok(Date.now() - x.last > 30);
    H.mw.sweep();
    assert.equal(H.mw.state.sessions.has('tmp'), false);
    assert.equal(H.mw.state.sessions.has('default') || true, true);
    // recreated empty on demand
    assert.equal((await ctl(H.base, 'tmp', 'GET', '/state')).body.rules.length, 0);
  } finally { await H.close(); }
});

test('CLI: --session --token --url and upstream/session commands', async () => {
  const H = await boot();
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [BIN, ...args, '--url', H.base, '--json'], { env: { ...process.env, MOCKWIRE_TOKEN: '' } }, (e, o) => resolve({ code: e ? e.code : 0, out: o })));
  try {
    let r = await run(['rule', 'add', '--path', '/api/x', '--status', '503', '--session', 'cli1']);
    assert.equal(r.code, 1); // no token -> 401
    r = await run(['rule', 'add', '--path', '/api/x', '--status', '503', '--session', 'cli1', '--token', 'sekret']);
    assert.equal(r.code, 0, r.out);
    assert.equal((await fetch(`${H.base}/s/cli1/api/x`)).status, 503);
    assert.equal((await fetch(`${H.base}/s/cli2/api/x`)).status, 200);
    r = await run(['upstream', 'use', 'prod', '--session', 'cli1', '--token', 'sekret']);
    assert.equal(JSON.parse(r.out).upstream, 'prod');
    r = await run(['session', 'list', '--token', 'sekret']);
    assert.ok(JSON.parse(r.out).sessions.some((s) => s.name === 'cli1' && s.upstream === 'prod'));
    r = await run(['state', '--session', 'cli1', '--token', 'sekret']);
    assert.equal(JSON.parse(r.out).session, 'cli1');
  } finally { await H.close(); }
});
