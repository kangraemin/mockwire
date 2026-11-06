'use strict';
const fs = require('node:fs');
const path = require('node:path');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const ACTIONS = ['mock', 'status', 'delay', 'drop', 'timeout', 'passthrough', 'modify'];
const ALLOWED = [
  // match
  'method', 'path', 'host', 'query', 'header', 'bodyContains', 'upstream',
  // meta
  'name', 'description', 'enabled', 'times', 'probability',
  // action
  'action', 'status', 'headers', 'json', 'text', 'file', 'delay', 'merge', 'set', 'remove',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function mkRegex(src, label) {
  try {
    return new RegExp(src);
  } catch (e) {
    throw new ValidationError(`${label}: invalid regex "${src}" (${e.message})`);
  }
}

function stripSlash(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** path: exact | glob (* ** :param) | "re:<regex>" */
function compilePath(p, label = 'path') {
  if (typeof p !== 'string' || !p) throw new ValidationError(`${label} must be a non-empty string`);
  if (p.startsWith('re:')) {
    const re = mkRegex(p.slice(3), label);
    return (s) => re.test(s);
  }
  if (!p.startsWith('/') && !p.includes('*')) {
    throw new ValidationError(`${label} "${p}" must start with "/" (or use "re:<regex>")`);
  }
  if (p.includes('*') || /\/:[A-Za-z_]/.test(p)) {
    let base = p;
    let tail = '/?';
    if (base.endsWith('/**')) {
      base = base.slice(0, -3);
      tail = '(/.*)?';
    }
    const src = base
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.split('**').map((a) => a.split('*').map(esc).join('[^/]*')).join('.*')))
      .join('/');
    const re = new RegExp(`^${src}${tail}$`);
    return (s) => re.test(s);
  }
  const exact = stripSlash(p);
  return (s) => stripSlash(s) === exact;
}

/** value matcher: string (exact) | "re:<regex>" | true (exists). receives string|null */
function compileValue(v, label) {
  if (v === true) return (s) => s != null;
  if (typeof v !== 'string') throw new ValidationError(`${label} must be a string, "re:<regex>" or true`);
  if (v.startsWith('re:')) {
    const re = mkRegex(v.slice(3), label);
    return (s) => s != null && re.test(s);
  }
  return (s) => s === v;
}

function compileMap(obj, label, lower) {
  if (!isObj(obj)) throw new ValidationError(`${label} must be an object like {"key":"value"}`);
  return Object.entries(obj).map(([k, v]) => [lower ? k.toLowerCase() : k, compileValue(v, `${label}.${k}`)]);
}

// ---- JSON path ($.a.b[0].c) ----
function parsePath(p, label = 'path') {
  if (typeof p !== 'string' || !p) throw new ValidationError(`${label}: JSON path must be a non-empty string like "$.data.count"`);
  let s = p.startsWith('$') ? p.slice(1) : p.startsWith('.') || p.startsWith('[') ? p : '.' + p;
  const tokens = [];
  const re = /\.([^.[\]]+)|\[(\d+)\]|\['([^']+)'\]/g;
  let m;
  let last = 0;
  while ((m = re.exec(s))) {
    if (m.index !== last) break;
    last = re.lastIndex;
    tokens.push(m[2] !== undefined ? Number(m[2]) : m[1] ?? m[3]);
  }
  if (!tokens.length || last !== s.length) throw new ValidationError(`${label}: cannot parse JSON path "${p}" (use $.a.b[0].c)`);
  return tokens;
}

function setPath(obj, tokens, value) {
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (cur[t] === null || typeof cur[t] !== 'object') cur[t] = typeof tokens[i + 1] === 'number' ? [] : {};
    cur = cur[t];
  }
  cur[tokens[tokens.length - 1]] = value;
}

function removePath(obj, tokens) {
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    cur = cur?.[tokens[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
  else delete cur[last];
}

/** apply modify spec to parsed JSON body; returns new value */
function applyModify(data, spec) {
  let out = data;
  if (spec.merge) {
    if (isObj(out)) out = { ...out, ...spec.merge };
    else if (out === undefined || out === null) out = { ...spec.merge };
  }
  if (spec.set && out !== null && typeof out === 'object') {
    for (const [p, v] of Object.entries(spec.set)) setPath(out, parsePath(p), v);
  }
  if (spec.remove && out !== null && typeof out === 'object') {
    for (const p of spec.remove) removePath(out, parsePath(p));
  }
  return out;
}

/**
 * Validate + compile one rule. Returns { spec, abs, test(ctx) }.
 * ctx = { method, path, host, query: URLSearchParams, headers, body: string|null, upstream }
 */
function normalizeRule(input, opts = {}) {
  if (!isObj(input)) throw new ValidationError('rule must be a JSON object');
  for (const k of Object.keys(input)) {
    if (!ALLOWED.includes(k)) throw new ValidationError(`unknown field "${k}". allowed fields: ${ALLOWED.join(', ')}`);
  }
  const s = { ...input };

  if (s.name !== undefined && typeof s.name !== 'string') throw new ValidationError('name must be a string');
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw new ValidationError('enabled must be true/false');
  if (s.times !== undefined && (!Number.isInteger(s.times) || s.times < 1)) throw new ValidationError('times must be an integer >= 1');
  if (s.probability !== undefined && (typeof s.probability !== 'number' || s.probability < 0 || s.probability > 1)) {
    throw new ValidationError('probability must be a number between 0 and 1');
  }
  if (s.status !== undefined && (!Number.isInteger(s.status) || s.status < 100 || s.status > 599)) {
    throw new ValidationError('status must be an integer 100-599');
  }
  if (s.delay !== undefined && (typeof s.delay !== 'number' || s.delay < 0 || s.delay > 3600000)) {
    throw new ValidationError('delay must be milliseconds between 0 and 3600000');
  }
  if (s.headers !== undefined) {
    if (!isObj(s.headers)) throw new ValidationError('headers (response headers) must be an object');
    for (const [k, v] of Object.entries(s.headers)) if (typeof v !== 'string') throw new ValidationError(`headers.${k} must be a string`);
  }
  if (s.merge !== undefined && !isObj(s.merge)) throw new ValidationError('merge must be a JSON object');
  if (s.set !== undefined) {
    if (!isObj(s.set)) throw new ValidationError('set must be an object like {"$.data.count": 0}');
    for (const p of Object.keys(s.set)) parsePath(p, 'set');
  }
  if (s.remove !== undefined) {
    if (!Array.isArray(s.remove)) throw new ValidationError('remove must be an array of JSON paths');
    for (const p of s.remove) parsePath(p, 'remove');
  }
  if (s.file !== undefined && typeof s.file !== 'string') throw new ValidationError('file must be a path string');
  if (s.text !== undefined && typeof s.text !== 'string') throw new ValidationError('text must be a string');
  if (s.bodyContains !== undefined && typeof s.bodyContains !== 'string') throw new ValidationError('bodyContains must be a string');
  if (s.upstream !== undefined && typeof s.upstream !== 'string') throw new ValidationError('upstream must be a string (upstream name)');
  if (s.description !== undefined && typeof s.description !== 'string') throw new ValidationError('description must be a string');
  if ([s.json !== undefined, s.text !== undefined, s.file !== undefined].filter(Boolean).length > 1) {
    throw new ValidationError('use only one of json / text / file');
  }

  // infer action
  if (s.action === undefined) {
    if (s.json !== undefined || s.text !== undefined || s.file !== undefined) s.action = 'mock';
    else if (s.merge || s.set || s.remove) s.action = 'modify';
    else if (s.status !== undefined) s.action = 'status';
    else if (s.delay !== undefined) s.action = 'delay';
    else throw new ValidationError(`cannot infer action; set "action" to one of: ${ACTIONS.join(', ')}`);
  }
  if (!ACTIONS.includes(s.action)) throw new ValidationError(`unknown action "${s.action}". allowed: ${ACTIONS.join(', ')}`);
  if (s.action === 'status' && s.status === undefined) s.status = 500;
  if (s.action === 'delay' && s.delay === undefined) throw new ValidationError('action "delay" requires "delay" (ms)');
  if (s.action === 'modify' && !s.merge && !s.set && !s.remove && s.status === undefined) {
    throw new ValidationError('action "modify" requires at least one of merge / set / remove / status');
  }
  if (s.enabled === undefined) s.enabled = true;

  let abs = null;
  if (s.file !== undefined) {
    abs = path.resolve(opts.baseDir || process.cwd(), s.file);
    if (!fs.existsSync(abs)) throw new ValidationError(`file not found: ${abs}`);
  }

  // matchers
  const tests = [];
  if (s.method !== undefined) {
    const arr = (Array.isArray(s.method) ? s.method : [s.method]).map((m) => {
      if (typeof m !== 'string') throw new ValidationError('method must be a string or array of strings');
      return m.toUpperCase();
    });
    if (!arr.includes('*')) tests.push((c) => arr.includes(c.method));
  }
  if (s.path !== undefined) {
    const f = compilePath(s.path);
    tests.push((c) => f(c.path));
  }
  if (s.host !== undefined) {
    if (typeof s.host !== 'string') throw new ValidationError('host must be a string');
    if (s.host.startsWith('re:')) {
      const re = mkRegex(s.host.slice(3), 'host');
      tests.push((c) => re.test(c.host || ''));
    } else {
      const f = compilePath('/' + s.host, 'host');
      tests.push((c) => f('/' + (c.host || '')));
    }
  }
  if (s.query !== undefined) {
    const m = compileMap(s.query, 'query', false);
    tests.push((c) => m.every(([k, f]) => f(c.query.get(k))));
  }
  if (s.header !== undefined) {
    const m = compileMap(s.header, 'header', true);
    tests.push((c) => m.every(([k, f]) => f(c.headers[k] ?? null)));
  }
  if (s.bodyContains !== undefined) tests.push((c) => c.body != null && c.body.includes(s.bodyContains));
  if (s.upstream !== undefined) tests.push((c) => c.upstream === s.upstream);

  return { spec: s, abs, test: (ctx) => tests.every((t) => t(ctx)) };
}

module.exports = { ValidationError, normalizeRule, applyModify, parsePath, ACTIONS, ALLOWED };
