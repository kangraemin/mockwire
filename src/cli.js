'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockwire, VERSION } = require('./server.js');

const BOOL = new Set(['json', 'quiet', 'drop', 'timeout', 'passthrough', 'disabled', 'last', 'insecure', 'no-cors', 'offline', 'help', 'version', 'force', 'tail-all']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v0] = a.slice(2).split(/=(.*)/s);
      let v = v0;
      if (v === undefined) {
        if (!BOOL.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) v = argv[++i];
        else v = true;
      }
      (flags[k] ||= []).push(v);
    } else pos.push(a);
  }
  return { pos, flags };
}
const one = (f, k) => (f[k] ? f[k][f[k].length - 1] : undefined);
const many = (f, k) => f[k] || [];

const HELP = `mockwire ${VERSION} - HTTP mock / fault-injection proxy (AI-friendly)

Server:
  mockwire start [--upstream URL | --upstream name=URL]... [--port 8899] [--host 0.0.0.0]
                 [--config mockwire.json] [--scenario NAME] [--offline] [--no-cors] [--insecure] [--quiet]
  mockwire init                      write example mockwire.json in cwd

Control a running instance (all support --json; target via --url http://127.0.0.1:8899, --port N or MOCKWIRE_URL):
  mockwire state
  mockwire rule add [--name N] [--method GET] [--path /api/x] [--query k=v] [--header k=v] [--body-contains S] [--host H]
                    ACTION: --status 500 [--body-json '{}'|--body-text S|--body-file F] [--resp-header k=v]
                            --body-json '{"a":1}' (mock 200) | --delay 3000 | --drop | --timeout | --passthrough
                            --merge '{"k":1}' --set '$.a.b=1' --remove '$.a' (modify real response)
                    OPTIONS: --times N --probability 0.5 --disabled --last (append instead of prepend)
  mockwire rule add --raw '<rule json or array>'
  mockwire rule list | rule rm <id|name> | rule enable|disable <id|name> | rule clear
  mockwire offline on|off|status
  mockwire scenario list | scenario use <name>
  mockwire log [--tail 20] [--clear]
  mockwire reset                     clear runtime rules, offline off, log cleared, scenario reset
  mockwire health
`;

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const json = !!one(flags, 'json');
  if (one(flags, 'version')) return console.log(VERSION);
  if (!pos.length || one(flags, 'help') || pos[0] === 'help') return console.log(HELP);

  const out = (obj, human) => {
    if (json) console.log(JSON.stringify(obj));
    else console.log(human !== undefined ? human : JSON.stringify(obj, null, 2));
  };
  const die = (msg, code = 1, extra) => {
    if (json) console.log(JSON.stringify({ error: { code: 'cli_error', message: msg, ...extra } }));
    else console.error('error: ' + msg);
    process.exit(code);
  };

  try {
    const cmd = pos[0];
    if (cmd === 'start') return await start(flags, json, die);
    if (cmd === 'init') return init(out, die);

    const base = (one(flags, 'url') || process.env.MOCKWIRE_URL || `http://127.0.0.1:${one(flags, 'port') || process.env.MOCKWIRE_PORT || 8899}`).replace(/\/$/, '');
    async function api(method, p, body) {
      let res;
      try {
        res = await fetch(`${base}/__mockwire${p}`, {
          method,
          headers: body !== undefined ? { 'content-type': 'application/json' } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        die(`cannot reach mockwire at ${base} (${e.cause?.code || e.message}). start it: mockwire start --upstream <url>`, 2);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) die(data?.error?.message || `HTTP ${res.status}`, 1, { status: res.status });
      return data;
    }

    const rest = pos.slice(1);
    switch (cmd) {
      case 'health': {
        const d = await api('GET', '/health');
        return out(d, `ok mockwire ${d.version}`);
      }
      case 'state': {
        const d = await api('GET', '/state');
        return out(d, human_state(d));
      }
      case 'reset': {
        const d = await api('POST', '/reset');
        return out(d, 'reset done');
      }
      case 'offline': {
        const v = rest[0] || 'status';
        if (v === 'status') {
          const d = await api('GET', '/offline');
          return out(d, `offline: ${d.offline ? 'on' : 'off'}`);
        }
        if (v !== 'on' && v !== 'off') return die('usage: mockwire offline on|off|status');
        const d = await api('PUT', `/offline/${v}`);
        return out(d, `offline: ${d.offline ? 'on' : 'off'}`);
      }
      case 'scenario': {
        if (rest[0] === 'use') {
          if (!rest[1]) return die('usage: mockwire scenario use <name>');
          const d = await api('POST', `/scenarios/${encodeURIComponent(rest[1])}/use`);
          return out(d, `scenario: ${d.scenario}`);
        }
        const d = await api('GET', '/scenarios');
        return out(d, `active: ${d.active || 'default'}\n` + d.scenarios.map((s) => `  ${s.name} (${s.rules} rules) ${s.description}`).join('\n'));
      }
      case 'log': {
        if (one(flags, 'clear')) {
          const d = await api('DELETE', '/log');
          return out(d, 'log cleared');
        }
        const d = await api('GET', `/log?tail=${Number(one(flags, 'tail')) || 20}`);
        return out(d, d.requests.map(fmt_log).join('\n') || '(no requests yet)');
      }
      case 'rule': {
        const sub = rest[0];
        if (sub === 'add') return await rule_add(flags, api, out, die);
        if (sub === 'list' || !sub) {
          const d = await api('GET', '/rules');
          return out(d, d.rules.map(fmt_rule).join('\n') || '(no rules)');
        }
        if (sub === 'clear') {
          const d = await api('DELETE', '/rules');
          return out(d, `removed ${d.removed} runtime rules`);
        }
        if (['rm', 'remove', 'delete', 'enable', 'disable'].includes(sub)) {
          if (!rest[1]) return die(`usage: mockwire rule ${sub} <id|name>`);
          const key = encodeURIComponent(rest[1]);
          if (['enable', 'disable'].includes(sub)) {
            const d = await api('PATCH', `/rules/${key}`, { enabled: sub === 'enable' });
            return out(d, fmt_rule(d.rule));
          }
          const d = await api('DELETE', `/rules/${key}`);
          return out(d, `removed ${d.removed}`);
        }
        return die('usage: mockwire rule add|list|rm|enable|disable|clear');
      }
      default:
        return die(`unknown command "${cmd}". run: mockwire help`);
    }
  } catch (e) {
    die(e.message);
  }
}

function human_state(d) {
  return [
    `mockwire ${d.version}  offline=${d.offline ? 'ON' : 'off'}  scenario=${d.scenario || 'default'}  requests=${d.requests}`,
    `upstreams: ${d.upstreams.map((u) => (u.name ? u.name + '=' : '') + u.url).join(', ') || '(none)'}`,
    d.configPath ? `config: ${d.configPath}${d.configError ? '  ERROR: ' + d.configError : ''}` : 'config: (none)',
    `rules (${d.rules.length}):`,
    ...d.rules.map((r) => '  ' + fmt_rule(r)),
  ].join('\n');
}
function fmt_rule(r) {
  const m = [r.method, r.path || '*', r.query && JSON.stringify(r.query), r.bodyContains && `body~${r.bodyContains}`].filter(Boolean).join(' ');
  const a = [r.action, r.status, r.delay && `${r.delay}ms`].filter(Boolean).join(' ');
  const o = [r.times && `times=${r.times}(left ${r.remaining})`, r.probability !== undefined && `p=${r.probability}`, !r.enabled && 'DISABLED'].filter(Boolean).join(' ');
  return `${r.id} ${r.name ? `"${r.name}" ` : ''}[${r.source}] ${m} => ${a} hits=${r.hits} ${o}`.trim();
}
function fmt_log(e) {
  return `${e.time.slice(11, 19)} #${e.id} ${e.method} ${e.url} -> ${e.status ?? e.outcome} ${e.action} ${e.ms}ms${e.rule ? ' rule=' + e.rule : ''}${e.error ? ' err=' + e.error : ''}`;
}

function kv(list, label, die) {
  const o = {};
  for (const s of list) {
    const i = String(s).indexOf('=');
    if (i < 1) die(`${label} expects key=value, got "${s}"`);
    o[s.slice(0, i)] = s.slice(i + 1);
  }
  return o;
}
function jsonArg(s, label, die) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return die(`${label} is not valid JSON: ${e.message}`);
  }
}

async function rule_add(flags, api, out, die) {
  let spec;
  const raw = one(flags, 'raw');
  if (raw) spec = jsonArg(raw, '--raw', die);
  else {
    spec = {};
    const s = (k, to = k) => one(flags, k) !== undefined && (spec[to] = one(flags, k));
    s('name'); s('method'); s('path'); s('host'); s('upstream');
    s('body-contains', 'bodyContains');
    if (many(flags, 'query').length) spec.query = kv(many(flags, 'query'), '--query', die);
    if (many(flags, 'header').length) spec.header = kv(many(flags, 'header'), '--header', die);
    if (many(flags, 'resp-header').length) spec.headers = kv(many(flags, 'resp-header'), '--resp-header', die);
    if (one(flags, 'status') !== undefined) spec.status = Number(one(flags, 'status'));
    if (one(flags, 'body-json') !== undefined) spec.json = jsonArg(one(flags, 'body-json'), '--body-json', die);
    if (one(flags, 'body-text') !== undefined) spec.text = one(flags, 'body-text');
    if (one(flags, 'body-file') !== undefined) spec.file = path.resolve(one(flags, 'body-file'));
    if (one(flags, 'delay') !== undefined) spec.delay = Number(one(flags, 'delay'));
    if (one(flags, 'times') !== undefined) spec.times = Number(one(flags, 'times'));
    if (one(flags, 'probability') !== undefined) spec.probability = Number(one(flags, 'probability'));
    if (one(flags, 'merge') !== undefined) spec.merge = jsonArg(one(flags, 'merge'), '--merge', die);
    if (many(flags, 'set').length) {
      spec.set = {};
      for (const e of many(flags, 'set')) {
        const i = String(e).indexOf('=');
        if (i < 1) die(`--set expects '$.path=value', got "${e}"`);
        const v = e.slice(i + 1);
        try {
          spec.set[e.slice(0, i)] = JSON.parse(v);
        } catch {
          spec.set[e.slice(0, i)] = v;
        }
      }
    }
    if (many(flags, 'remove').length) spec.remove = many(flags, 'remove');
    if (one(flags, 'drop')) spec.action = 'drop';
    if (one(flags, 'timeout')) spec.action = 'timeout';
    if (one(flags, 'passthrough')) spec.action = 'passthrough';
    if (one(flags, 'disabled')) spec.enabled = false;
  }
  const d = await api('POST', `/rules${one(flags, 'last') ? '?position=last' : ''}`, spec);
  const rules = d.rules || [d.rule];
  return out(d, rules.map((r) => 'added ' + fmt_rule(r)).join('\n'));
}

const EXAMPLE = {
  $schema: './node_modules/mockwire/schema/mockwire.config.schema.json',
  upstream: 'https://api.example.com',
  port: 8899,
  rules: [],
  scenarios: {
    server_error: { description: 'ranking API returns 500', rules: [{ name: 'ranking-500', method: 'GET', path: '/api/ranking', status: 500 }] },
    empty: { description: 'list endpoints return empty arrays', rules: [{ name: 'empty-list', method: 'GET', path: '/api/**', json: [] }] },
    slow: { description: '3s latency on everything', rules: [{ name: 'slow-all', action: 'passthrough', delay: 3000 }] },
    flaky: { description: '30% connection drops', rules: [{ name: 'flaky', action: 'drop', probability: 0.3 }] },
  },
};
function init(out, die) {
  const f = path.resolve('mockwire.json');
  if (fs.existsSync(f)) return die('mockwire.json already exists');
  fs.writeFileSync(f, JSON.stringify(EXAMPLE, null, 2) + '\n');
  out({ created: f }, `created ${f}`);
}

async function start(flags, json, die) {
  let mw;
  try {
    mw = createMockwire({
      upstreams: many(flags, 'upstream'),
      config: one(flags, 'config'),
      scenario: one(flags, 'scenario'),
      offline: !!one(flags, 'offline'),
      cors: !one(flags, 'no-cors'),
      insecure: !!one(flags, 'insecure'),
      port: one(flags, 'port') !== undefined ? Number(one(flags, 'port')) : undefined,
      host: one(flags, 'host'),
      logger: one(flags, 'quiet') ? null : (l) => console.log(json ? JSON.stringify({ event: 'request', line: l }) : l),
    });
  } catch (e) {
    return die(e.message);
  }
  let addr;
  try {
    addr = await mw.listen();
  } catch (e) {
    return die(e.code === 'EADDRINUSE' ? `port already in use (${e.message}). use --port <other>` : e.message);
  }
  const port = addr.port;
  const S = mw.state;
  const lan = lanIps();
  if (json) {
    console.log(JSON.stringify({ event: 'listening', port, urls: { local: `http://localhost:${port}`, androidEmulator: `http://10.0.2.2:${port}`, lan: lan.map((i) => `http://${i}:${port}`) }, upstreams: S.upstreams.map((u) => ({ name: u.name, url: u.url })), config: S.configPath }));
  } else {
    console.log(`mockwire ${VERSION} listening on port ${port}`);
    console.log(`  upstream:  ${S.upstreams.map((u) => (u.name ? u.name + '=' : '') + u.url).join(', ') || '(none - mock-only)'}`);
    console.log(`  ios sim / web / desktop:  http://localhost:${port}`);
    console.log(`  android emulator:         http://10.0.2.2:${port}`);
    for (const i of lan) console.log(`  real device (LAN):        http://${i}:${port}`);
    console.log(`  control:   http://localhost:${port}/__mockwire/state   (CLI: mockwire state)`);
    console.log(`  config:    ${S.configPath ? S.configPath + ' (hot reload)' : '(none)'}${S.scenario ? '  scenario=' + S.scenario : ''}`);
  }
  process.on('uncaughtException', (e) => console.error('mockwire: uncaught', e.message));
  process.on('unhandledRejection', (e) => console.error('mockwire: unhandled', e && e.message));
  const stop = () => mw.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { main, parseArgs };
