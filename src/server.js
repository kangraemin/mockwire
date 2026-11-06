'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { ValidationError, normalizeRule, applyModify } = require('./rules.js');

const VERSION = require('../package.json').version;
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const MAX_BODY = 20 * 1024 * 1024;
const LOG_MAX = 500;
const CONTROL = '/__mockwire';
const CONFIG_KEYS = ['$schema', 'upstream', 'upstreams', 'port', 'scenario', 'rules', 'scenarios'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseUpstream(str) {
  // "https://x" or "name=https://x"
  let name = null;
  let url = str;
  const m = /^([A-Za-z0-9_-]+)=(https?:\/\/.*)$/.exec(str);
  if (m) [, name, url] = m;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ValidationError(`invalid upstream URL "${str}" (expected https://host[/base] or name=https://host)`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new ValidationError(`upstream must be http(s): "${str}"`);
  return { name, url: u.href.replace(/\/$/, ''), u };
}

function sleep(ms, res) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      res.off('close', onClose);
      resolve(true);
    }, ms);
    const onClose = () => {
      clearTimeout(t);
      resolve(false);
    };
    res.once('close', onClose);
  });
}

function decode(buf, enc) {
  enc = (enc || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  if (enc === 'deflate') return zlib.inflateSync(buf);
  return buf;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {string[]} [options.upstreams]  ["https://a", "name=https://b"]
 * @param {string} [options.config]       config path (hot reload). default ./mockwire.json if present
 * @param {string} [options.scenario]
 * @param {boolean} [options.offline]
 * @param {boolean} [options.cors=true]
 * @param {boolean} [options.insecure]    allow self-signed upstream TLS
 * @param {(line:string)=>void} [options.logger]  one line per request (default console.log; null = silent)
 */
function createMockwire(options = {}) {
  const logger = options.logger === undefined ? (l) => console.log(l) : options.logger;
  const cors = options.cors !== false;
  const S = {
    upstreams: [],
    offline: !!options.offline,
    scenario: null,
    initialScenario: options.scenario || null,
    scenarios: {},
    baseRules: [],
    scenarioRules: [],
    runtimeRules: [],
    log: [],
    seq: 0,
    ruleSeq: 0,
    configPath: null,
    configDir: process.cwd(),
    configError: null,
    configPort: null,
  };

  // ---------- rules ----------
  function mkRule(input, source, baseDir) {
    const { spec, abs, test } = normalizeRule(input, { baseDir: baseDir || S.configDir });
    return { id: (source === 'runtime' ? 'r' : 's') + ++S.ruleSeq, source, spec, abs, test, hits: 0 };
  }
  function publicRule(r) {
    return {
      id: r.id,
      source: r.source,
      ...r.spec,
      hits: r.hits,
      remaining: r.spec.times ? Math.max(0, r.spec.times - r.hits) : null,
    };
  }
  const allRules = () => [...S.runtimeRules, ...S.scenarioRules, ...S.baseRules];
  function findRule(key) {
    return allRules().find((r) => r.id === key || r.spec.name === key);
  }
  function rebuildScenarioRules() {
    const sc = S.scenario && S.scenarios[S.scenario];
    S.scenarioRules = sc ? sc.rules.map((r) => mkRule(r, 'scenario')) : [];
  }

  // ---------- config ----------
  function parseConfig(text, baseDir) {
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch (e) {
      throw new ValidationError(`config is not valid JSON: ${e.message}`);
    }
    if (!isObj(cfg)) throw new ValidationError('config must be a JSON object');
    for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.includes(k)) throw new ValidationError(`config: unknown key "${k}". allowed: ${CONFIG_KEYS.join(', ')}`);
    const out = { cfg, base: [], scenarios: {} };
    (cfg.rules || []).forEach((r, i) => {
      try {
        normalizeRule(r, { baseDir });
      } catch (e) {
        throw new ValidationError(`rules[${i}]: ${e.message}`);
      }
    });
    out.base = cfg.rules || [];
    if (cfg.scenarios !== undefined && !isObj(cfg.scenarios)) throw new ValidationError('scenarios must be an object {name:{rules:[]}}');
    for (const [name, sc] of Object.entries(cfg.scenarios || {})) {
      if (!isObj(sc) || !Array.isArray(sc.rules || [])) throw new ValidationError(`scenarios.${name}: expected {"rules":[...]}`);
      (sc.rules || []).forEach((r, i) => {
        try {
          normalizeRule(r, { baseDir });
        } catch (e) {
          throw new ValidationError(`scenarios.${name}.rules[${i}]: ${e.message}`);
        }
      });
      out.scenarios[name] = { description: sc.description || '', rules: sc.rules || [] };
    }
    if (cfg.scenario !== undefined && cfg.scenario !== 'default' && !out.scenarios[cfg.scenario]) {
      throw new ValidationError(`scenario "${cfg.scenario}" not defined in scenarios`);
    }
    return out;
  }

  function applyConfig(parsed, first) {
    S.scenarios = parsed.scenarios;
    S.baseRules = parsed.base.map((r) => mkRule(r, 'base'));
    const want = first ? S.initialScenario || parsed.cfg.scenario : S.scenario;
    S.scenario = want && (want === 'default' || S.scenarios[want]) ? want : parsed.cfg.scenario || null;
    rebuildScenarioRules();
    S.configError = null;
    if (first) {
      const ups = [];
      if (parsed.cfg.upstream) ups.push(parsed.cfg.upstream);
      for (const [n, u] of Object.entries(parsed.cfg.upstreams || {})) ups.push(`${n}=${u}`);
      S.configUpstreams = ups;
      S.configPort = parsed.cfg.port ?? null;
    }
  }

  function loadConfigFile(first) {
    try {
      const text = fs.readFileSync(S.configPath, 'utf8');
      applyConfig(parseConfig(text, S.configDir), first);
      if (!first && logger) logger(`${ts()} config reloaded (${S.configPath})`);
      return true;
    } catch (e) {
      S.configError = e.message;
      if (logger) logger(`${ts()} config error (kept previous rules): ${e.message}`);
      return false;
    }
  }

  let watching = false;
  function initConfig() {
    let p = options.config;
    if (!p && fs.existsSync(path.resolve('mockwire.json'))) p = 'mockwire.json';
    if (p) {
      S.configPath = path.resolve(p);
      S.configDir = path.dirname(S.configPath);
      if (!fs.existsSync(S.configPath)) throw new ValidationError(`config file not found: ${S.configPath}`);
      const text = fs.readFileSync(S.configPath, 'utf8');
      applyConfig(parseConfig(text, S.configDir), true); // throws on startup if invalid
      let last = '';
      fs.watchFile(S.configPath, { interval: 150 }, () => {
        try {
          const t = fs.readFileSync(S.configPath, 'utf8');
          if (t === last) return;
          last = t;
        } catch {
          return;
        }
        loadConfigFile(false);
      });
      watching = true;
    }
    const ups = (options.upstreams && options.upstreams.length ? options.upstreams : S.configUpstreams) || [];
    S.upstreams = ups.map(parseUpstream);
    const names = new Set();
    for (const u of S.upstreams) {
      const k = u.name || '';
      if (names.has(k)) throw new ValidationError(k ? `duplicate upstream name "${k}"` : 'only one unnamed (default) upstream allowed');
      names.add(k);
    }
  }

  // ---------- logging ----------
  const ts = () => new Date().toTimeString().slice(0, 8);
  function record(e) {
    e.id = ++S.seq;
    S.log.push(e);
    if (S.log.length > LOG_MAX) S.log.shift();
    if (logger) {
      const rule = e.rule ? ` rule=${e.rule}` : '';
      logger(`${ts()} ${e.method} ${e.url} -> ${e.status ?? e.outcome} ${e.action} ${e.ms}ms${rule}${e.error ? ' err=' + e.error : ''}`);
    }
  }

  // ---------- CORS ----------
  function corsHeaders(req, h) {
    const origin = req.headers.origin;
    if (!cors || !origin) return h;
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('access-control-')) delete h[k];
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
    h['access-control-expose-headers'] = 'x-mockwire-rule, x-mockwire-action';
    h.vary = h.vary ? `${h.vary}, Origin` : 'Origin';
    return h;
  }

  function sendJson(req, res, status, obj, extra = {}) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, corsHeaders(req, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...extra }));
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---------- upstream selection ----------
  function pickUpstream(pathname) {
    for (const u of S.upstreams) {
      if (u.name && (pathname === '/' + u.name || pathname.startsWith('/' + u.name + '/'))) {
        return { up: u, path: pathname.slice(u.name.length + 1) || '/' };
      }
    }
    const def = S.upstreams.find((u) => !u.name);
    return def ? { up: def, path: pathname } : { up: null, path: pathname };
  }

  function upstreamUrl(up, p, search) {
    const base = new URL(up.url);
    const basePath = base.pathname.replace(/\/$/, '');
    base.pathname = basePath + p;
    base.search = search;
    return base;
  }

  // ---------- forwarding ----------
  function forward(req, res, target, { body, modify, rule, entry }) {
    return new Promise((resolve) => {
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { ...req.headers };
      for (const h of HOP) delete headers[h];
      headers.host = target.host;
      if (modify) headers['accept-encoding'] = 'identity';
      if (body) headers['content-length'] = String(body.length);
      const preq = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: req.method,
          headers,
          rejectUnauthorized: !options.insecure,
        },
        (pres) => {
          const rh = { ...pres.headers };
          for (const h of HOP) delete rh[h];
          entry.status = pres.statusCode;
          const ctype = String(rh['content-type'] || '');
          if (modify && /json/i.test(ctype)) {
            const chunks = [];
            pres.on('data', (c) => chunks.push(c));
            pres.on('end', () => {
              let out = Buffer.concat(chunks);
              try {
                out = decode(out, rh['content-encoding']);
                delete rh['content-encoding'];
                const data = applyModify(JSON.parse(out.toString('utf8')), rule.spec);
                out = Buffer.from(JSON.stringify(data));
                entry.modified = true;
              } catch (e) {
                entry.error = 'modify skipped: ' + e.message;
              }
              rh['content-length'] = out.length;
              rh['x-mockwire-rule'] = rule.spec.name || rule.id;
              rh['x-mockwire-action'] = 'modify';
              const status = rule.spec.status || pres.statusCode;
              entry.status = status;
              res.writeHead(status, corsHeaders(req, rh));
              res.end(out);
            });
            pres.on('error', () => res.destroy());
          } else {
            res.writeHead(pres.statusCode, pres.statusMessage, corsHeaders(req, rh));
            pipeline(pres, res, () => {});
          }
        },
      );
      res.once('close', () => {
        preq.destroy();
        resolve();
      });
      preq.on('error', (e) => {
        entry.error = e.code || e.message;
        entry.outcome = 'upstream_error';
        if (!res.headersSent) {
          entry.status = 502;
          sendJson(req, res, 502, { error: { code: 'upstream_error', message: `cannot reach upstream ${target.origin}: ${e.code || e.message}` } });
        } else res.destroy();
      });
      if (body) preq.end(body);
      else req.pipe(preq);
    });
  }

  function mockResponse(req, res, rule, entry) {
    const s = rule.spec;
    let status = s.status || 200;
    const h = { 'x-mockwire-rule': s.name || rule.id, 'x-mockwire-action': s.action };
    let body;
    if (s.json !== undefined) {
      body = Buffer.from(JSON.stringify(s.json));
      h['content-type'] = 'application/json; charset=utf-8';
    } else if (s.text !== undefined) {
      body = Buffer.from(s.text);
      h['content-type'] = 'text/plain; charset=utf-8';
    } else if (rule.abs) {
      try {
        body = fs.readFileSync(rule.abs);
        h['content-type'] = /\.json$/i.test(rule.abs) ? 'application/json; charset=utf-8' : /\.html?$/i.test(rule.abs) ? 'text/html; charset=utf-8' : 'application/octet-stream';
      } catch (e) {
        status = 500;
        body = Buffer.from(JSON.stringify({ error: { code: 'mock_file_error', message: e.message } }));
        h['content-type'] = 'application/json; charset=utf-8';
      }
    } else {
      body = Buffer.from(JSON.stringify({ error: { code: 'mockwire_injected', message: `mockwire injected HTTP ${status}` } }));
      h['content-type'] = 'application/json; charset=utf-8';
    }
    Object.assign(h, s.headers || {});
    const noBody = status === 204 || status === 304 || req.method === 'HEAD';
    h['content-length'] = noBody ? 0 : body.length;
    entry.status = status;
    res.writeHead(status, corsHeaders(req, h));
    res.end(noBody ? undefined : body);
  }

  // ---------- main handler ----------
  async function onRequest(req, res) {
    const t0 = Date.now();
    const isForward = /^https?:\/\//i.test(req.url);
    let url;
    try {
      url = isForward ? new URL(req.url) : new URL('http://x' + req.url);
    } catch {
      res.writeHead(400);
      return res.end('bad request');
    }
    if (!isForward && (url.pathname === CONTROL || url.pathname.startsWith(CONTROL + '/'))) {
      return control(req, res, url);
    }

    const entry = {
      time: new Date().toISOString(),
      method: req.method,
      url: url.pathname + url.search,
      mode: isForward ? 'forward' : 'reverse',
      upstream: null,
      rule: null,
      action: 'passthrough',
      status: null,
      outcome: 'ok',
      ms: 0,
    };
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      entry.ms = Date.now() - t0;
      record(entry);
    };
    res.once('close', () => {
      if (!finished && entry.outcome === 'ok' && !res.writableFinished) entry.outcome = 'client_aborted';
      done();
    });

    try {
      if (S.offline) {
        entry.action = 'offline';
        entry.outcome = 'dropped';
        req.socket.destroy();
        return;
      }

      // CORS preflight (reverse mode)
      if (cors && !isForward && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        entry.action = 'cors-preflight';
        entry.status = 204;
        res.writeHead(204, {
          'access-control-allow-origin': req.headers.origin || '*',
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
          'access-control-max-age': '600',
          vary: 'Origin',
          'content-length': 0,
        });
        return res.end();
      }

      let target = null;
      let pathname = url.pathname;
      let upName = null;
      if (isForward) {
        target = url;
      } else {
        const { up, path: p } = pickUpstream(url.pathname);
        pathname = p;
        if (up) {
          upName = up.name;
          entry.upstream = up.name || 'default';
          target = upstreamUrl(up, p, url.search);
        }
      }

      const rules = allRules();
      const needBody = rules.some((r) => r.spec.enabled && r.spec.bodyContains !== undefined);
      let bodyBuf = null;
      if (needBody) bodyBuf = await readBody(req);

      const ctx = {
        method: req.method,
        path: pathname,
        host: isForward ? url.host : req.headers.host,
        query: url.searchParams,
        headers: req.headers,
        body: bodyBuf ? bodyBuf.toString('utf8') : null,
        upstream: upName,
      };

      let rule = null;
      for (const r of rules) {
        const s = r.spec;
        if (!s.enabled) continue;
        if (s.times && r.hits >= s.times) continue;
        let ok = false;
        try {
          ok = r.test(ctx);
        } catch {
          ok = false;
        }
        if (!ok) continue;
        if (s.probability !== undefined && Math.random() >= s.probability) continue;
        rule = r;
        break;
      }

      if (rule) {
        rule.hits++;
        entry.rule = rule.spec.name || rule.id;
        entry.action = rule.spec.action;
        if (rule.spec.delay) {
          const ok = await sleep(rule.spec.delay, res);
          if (!ok) return;
        }
        switch (rule.spec.action) {
          case 'drop':
            entry.outcome = 'dropped';
            req.socket.destroy();
            return;
          case 'timeout':
            entry.outcome = 'timeout';
            return; // leave open until client gives up (res 'close' records it)
          case 'mock':
          case 'status':
            if (!bodyBuf && req.readable) req.resume();
            return mockResponse(req, res, rule, entry);
          default:
            break; // passthrough | delay | modify -> forward
        }
      }

      if (!target) {
        entry.status = 502;
        entry.outcome = 'no_upstream';
        return sendJson(req, res, 502, {
          error: { code: 'no_upstream', message: `no rule matched and no upstream configured for ${req.method} ${url.pathname}. start with --upstream <url>` },
        });
      }
      await forward(req, res, target, { body: bodyBuf, modify: rule?.spec.action === 'modify', rule, entry });
    } catch (e) {
      entry.error = e.message;
      entry.outcome = 'error';
      if (!res.headersSent) {
        entry.status = e.status || 500;
        sendJson(req, res, entry.status, { error: { code: 'mockwire_error', message: e.message } });
      } else res.destroy();
    }
  }

  // ---------- control API ----------
  async function control(req, res, url) {
    const p = url.pathname.slice(CONTROL.length).replace(/\/$/, '') || '/';
    const m = req.method;
    const fail = (status, code, message) => sendJson(req, res, status, { error: { code, message } });
    try {
      if (m === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': '*', 'content-length': 0 }));
        return res.end();
      }
      let body;
      if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
        const raw = (await readBody(req)).toString('utf8').trim();
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch (e) {
            return fail(400, 'invalid_json', `request body is not valid JSON: ${e.message}`);
          }
        }
      }
      const ok = (obj, status = 200) => sendJson(req, res, status, obj);

      if (p === '/' || p === '/health') return ok({ ok: true, name: 'mockwire', version: VERSION });

      if (p === '/state' && m === 'GET') {
        return ok({
          version: VERSION,
          offline: S.offline,
          scenario: S.scenario,
          scenarios: Object.keys(S.scenarios),
          upstreams: S.upstreams.map((u) => ({ name: u.name, url: u.url })),
          configPath: S.configPath,
          configError: S.configError,
          requests: S.seq,
          rules: allRules().map(publicRule),
        });
      }

      if (p === '/rules') {
        if (m === 'GET') return ok({ rules: allRules().map(publicRule) });
        if (m === 'DELETE') {
          const n = S.runtimeRules.length;
          S.runtimeRules = [];
          return ok({ removed: n });
        }
        if (m === 'POST') {
          if (body === undefined) return fail(400, 'validation_error', 'body required: a rule object or array of rules');
          const list = Array.isArray(body) ? body : [body];
          const made = [];
          list.forEach((r, i) => {
            try {
              made.push(mkRule(r, 'runtime'));
            } catch (e) {
              throw new ValidationError(Array.isArray(body) ? `rules[${i}]: ${e.message}` : e.message);
            }
          });
          if (url.searchParams.get('position') === 'last') S.runtimeRules.push(...made);
          else S.runtimeRules.unshift(...made);
          return ok(Array.isArray(body) ? { rules: made.map(publicRule) } : { rule: publicRule(made[0]) }, 201);
        }
      }

      let mm = /^\/rules\/([^/]+)$/.exec(p);
      if (mm) {
        const key = decodeURIComponent(mm[1]);
        const r = findRule(key);
        if (!r) return fail(404, 'not_found', `no rule with id or name "${key}"`);
        if (m === 'GET') return ok({ rule: publicRule(r) });
        if (m === 'DELETE') {
          if (r.source !== 'runtime') return fail(400, 'not_runtime_rule', `rule "${key}" comes from the config file; edit the file or disable it with PATCH {"enabled":false}`);
          S.runtimeRules = S.runtimeRules.filter((x) => x !== r);
          return ok({ removed: r.id });
        }
        if (m === 'PATCH') {
          if (!isObj(body)) return fail(400, 'validation_error', 'body must be a JSON object of fields to change');
          const next = normalizeRule({ ...r.spec, ...body }, { baseDir: S.configDir });
          r.spec = next.spec;
          r.abs = next.abs;
          r.test = next.test;
          if (body.times !== undefined || body.reset) r.hits = 0;
          return ok({ rule: publicRule(r) });
        }
      }

      mm = /^\/offline(?:\/(on|off))?$/.exec(p);
      if (mm) {
        if (m === 'GET') return ok({ offline: S.offline });
        if (m === 'PUT' || m === 'POST') {
          let on;
          if (mm[1]) on = mm[1] === 'on';
          else if (isObj(body) && typeof body.on === 'boolean') on = body.on;
          else return fail(400, 'validation_error', 'body must be {"on":true|false} (or use /offline/on, /offline/off)');
          S.offline = on;
          return ok({ offline: S.offline });
        }
      }

      if (p === '/reset' && m === 'POST') {
        S.runtimeRules = [];
        S.offline = false;
        S.log = [];
        S.scenario = S.initialScenario || null;
        if (S.configPath) loadConfigFile(true);
        else rebuildScenarioRules();
        return ok({ ok: true, scenario: S.scenario });
      }

      if (p === '/log') {
        if (m === 'GET') {
          const tail = Number(url.searchParams.get('tail') || 50);
          const n = Number.isFinite(tail) && tail > 0 ? tail : 50;
          return ok({ requests: S.log.slice(-n), total: S.seq });
        }
        if (m === 'DELETE') {
          S.log = [];
          return ok({ ok: true });
        }
      }

      if (p === '/scenarios' && m === 'GET') {
        return ok({
          active: S.scenario,
          scenarios: Object.entries(S.scenarios).map(([name, s]) => ({ name, description: s.description, rules: s.rules.length })),
        });
      }
      mm = /^\/scenarios\/([^/]+)\/use$/.exec(p);
      if (mm || (p === '/scenario' && m === 'PUT')) {
        if (m !== 'POST' && m !== 'PUT') return fail(405, 'method_not_allowed', 'use POST');
        const name = mm ? decodeURIComponent(mm[1]) : body?.name;
        if (typeof name !== 'string') return fail(400, 'validation_error', 'body must be {"name":"<scenario>"}');
        if (name !== 'default' && !S.scenarios[name]) {
          return fail(404, 'not_found', `unknown scenario "${name}". available: ${['default', ...Object.keys(S.scenarios)].join(', ')}`);
        }
        S.scenario = name;
        rebuildScenarioRules();
        return ok({ scenario: S.scenario });
      }

      return fail(404, 'not_found', `no such control endpoint: ${m} ${CONTROL}${p}`);
    } catch (e) {
      const status = e.status || 500;
      return fail(status, status === 400 ? 'validation_error' : 'mockwire_error', e.message);
    }
  }

  // ---------- CONNECT tunnel (https passthrough, no MITM) ----------
  function onConnect(req, socket, head) {
    const t0 = Date.now();
    const entry = { time: new Date().toISOString(), method: 'CONNECT', url: req.url, mode: 'connect', upstream: null, rule: null, action: 'tunnel', status: null, outcome: 'ok', ms: 0 };
    let fin = false;
    const finish = () => {
      if (fin) return;
      fin = true;
      entry.ms = Date.now() - t0;
      record(entry);
    };
    socket.on('error', () => {});
    if (S.offline) {
      entry.action = 'offline';
      entry.outcome = 'dropped';
      socket.destroy();
      return finish();
    }
    const [host, port] = req.url.split(/:(?=\d+$)/);
    const up = net.connect(Number(port) || 443, host.replace(/^\[|\]$/g, ''), () => {
      entry.status = 200;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', (e) => {
      entry.error = e.code || e.message;
      entry.outcome = 'upstream_error';
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      finish();
    });
    socket.on('close', () => {
      up.destroy();
      finish();
    });
  }

  initConfig();

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      try {
        if (!res.headersSent) sendJson(req, res, 500, { error: { code: 'mockwire_error', message: e.message } });
        else res.destroy();
      } catch {
        /* ignore */
      }
    });
  });
  server.on('connect', onConnect);
  server.on('connection', (s) => s.on('error', () => {}));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return {
    server,
    state: S,
    listen(port = options.port ?? S.configPort ?? 8899, host = options.host || '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      if (watching) fs.unwatchFile(S.configPath);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = { createMockwire, parseUpstream, VERSION };
