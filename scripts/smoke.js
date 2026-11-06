'use strict';
// Smoke test against a real upstream: node scripts/smoke.js [https://host] [/path]
const { createMockwire } = require('../src/index.js');
const upstream = process.argv[2] || 'https://runnershi-api.oguriworks.com';
const p = process.argv[3] || '/api/terms';
(async () => {
  const mw = createMockwire({ upstreams: [upstream], logger: (l) => console.log('  log>', l) });
  const { port } = await mw.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const ctl = (m, x, b) => fetch(`${base}/__mockwire${x}`, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());
  const hit = async (label) => {
    try {
      const r = await fetch(base + p, { signal: AbortSignal.timeout(8000) });
      const t = await r.text();
      console.log(`${label}: HTTP ${r.status} ${t.slice(0, 70).replace(/\n/g, ' ')}`);
    } catch (e) { console.log(`${label}: FAILED (${e.cause?.code || e.name})`); }
  };
  await hit('1 passthrough');
  await ctl('POST', '/rules', { name: 'mock', path: p, json: { mocked: true } });
  await hit('2 mock       ');
  await ctl('DELETE', '/rules');
  await ctl('POST', '/rules', { name: 'e500', path: p, status: 500 });
  await hit('3 status 500 ');
  await ctl('DELETE', '/rules');
  await ctl('POST', '/rules', { name: 'drop', path: p, action: 'drop' });
  await hit('4 drop       ');
  await ctl('POST', '/reset');
  await ctl('PUT', '/offline/on');
  await hit('5 offline    ');
  await ctl('PUT', '/offline/off');
  await hit('6 back online');
  await mw.close();
  process.exit(0);
})();
