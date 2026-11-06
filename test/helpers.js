'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const { createMockwire } = require('../src/index.js');

/** fake upstream: echo + gzip json + slow */
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/gzip') {
          const gz = zlib.gzipSync(JSON.stringify({ a: 1, b: { c: 2 }, list: [1, 2, 3] }));
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length });
          return res.end(gz);
        }
        if (u.pathname === '/json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ a: 1, b: { c: 2 }, list: [1, 2, 3] }));
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' });
        res.end(JSON.stringify({ from: 'upstream', method: req.method, url: req.url, host: req.headers.host, body, headers: req.headers }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function startProxy(opts = {}) {
  const up = opts.noUpstream ? null : await startUpstream();
  const mw = createMockwire({ upstreams: up ? [up.url] : [], logger: null, ...opts });
  const addr = await mw.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const ctl = async (method, p, body) => {
    const r = await fetch(`${base}/__mockwire${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return {
    mw, up, base, ctl, port: addr.port,
    async close() {
      await mw.close();
      if (up) {
        up.server.closeAllConnections?.();
        await new Promise((r) => up.server.close(r));
      }
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}

module.exports = { startUpstream, startProxy, wait, until };
