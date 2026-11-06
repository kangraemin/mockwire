# mockwire - instructions for AI agents

HTTP mock / fault-injection proxy. App base URL -> mockwire -> real server. Rules turn matching requests into mocks, errors, delays, dropped connections, hangs; everything else passes through.
Node >= 18, zero deps. Run: `npx github:kangraemin/mockwire <cmd>` (or `node bin/mockwire.js <cmd>`, or `mockwire` if installed).

## 1. Start (once, keep running in background)
```
mockwire start --upstream https://api.example.com --port 8899        # reverse proxy
mockwire start --config mockwire.json                                 # rules/scenarios from file (hot reload)
mockwire start --upstream a=https://a.com --upstream https://b.com    # /a/... -> a.com, rest -> b.com
mockwire start --json                                                 # first stdout line: {"event":"listening","port":...}
```
Point the app's BASE_URL at: iOS simulator/web/desktop `http://localhost:8899`, Android emulator `http://10.0.2.2:8899`, real device `http://<mac-lan-ip>:8899`.
Port default 8899. Check: `mockwire health --json` -> `{"ok":true,"name":"mockwire","version":"x"}`.

## 2. Drive it (every command takes --json; target via `--url http://127.0.0.1:8899`, `--port N` or env MOCKWIRE_URL)
```
mockwire rule add --method GET --path /api/ranking --status 500                      # 500 error
mockwire rule add --path /api/me --body-json '{"name":"test"}'                       # mock 200 JSON
mockwire rule add --path /api/x --status 404 --body-json '{"message":"nope"}'
mockwire rule add --path '/api/**' --delay 5000                                      # slow, then real response
mockwire rule add --path /api/x --drop                                               # connection lost
mockwire rule add --path /api/x --timeout                                            # hangs forever
mockwire rule add --path /api/terms --set '$.data[0].version=99' --merge '{"k":1}'   # patch the real JSON
mockwire rule add --path /api/x --status 500 --times 1                               # only the first call fails
mockwire rule add --path /api/x --status 500 --probability 0.3
mockwire rule add --raw '{"path":"/a","status":503}'                                 # raw rule JSON (object or array)
mockwire rule list | rule rm <id|name> | rule enable|disable <id|name> | rule clear
mockwire offline on | off | status        # every request (incl. CONNECT) loses its connection
mockwire scenario list | scenario use <name>
mockwire log --tail 20 --json             # what the app actually sent + which rule matched
mockwire state --json                     # offline, scenario, upstreams, rules with hits/remaining
mockwire reset                            # clear runtime rules, offline off, log cleared
```
Typical loop: `reset` -> add rule -> run app/test -> `log --tail 5 --json` to verify (`rule` field = matched rule name, `null` = passthrough) -> `reset`.

## 3. Rule JSON (POST /__mockwire/rules, config `rules[]`)
Match (all given fields must match; omit = any):
- `method`: "GET" | ["GET","POST"] | "*"
- `path`: exact `/a/b` | glob `/a/*` (one segment) `/a/**` (any depth) | param `/a/:id` | regex `re:^/a/\d+$`. Query string is NOT part of path. Trailing slash ignored. With named upstreams, path is after the `/<name>` prefix.
- `query`: `{"k":"v"}` exact | `"re:..."` | `true` (exists)
- `header`: request headers, same value forms, names case-insensitive
- `bodyContains`: substring of request body
- `host`: request Host (reverse) / target host (forward proxy); `upstream`: named upstream
Action (`action` inferred if omitted: json/text/file->mock, merge/set/remove->modify, status->status, delay->delay; `drop`/`timeout`/`passthrough` must be explicit):
- `mock`: `status` (default 200), `headers`, one of `json` | `text` | `file` (relative to config file)
- `status`: `status` (default 500), optional body via json/text; default body `{"error":{"code":"mockwire_injected",...}}`
- `delay`: `delay` ms then passthrough. `delay` can ALSO be set on any other action (waits first)
- `drop`: destroy socket (connection lost). `timeout`: never respond
- `passthrough`: forward to upstream (use with `delay`, or to shadow a later broad rule)
- `modify`: passthrough, then patch JSON response: `merge` (shallow), `set` `{"$.a.b[0].c": v}`, `remove` `["$.a"]`, optional `status`
Options: `name`, `enabled` (default true), `times` (N applications then skipped), `probability` 0..1, `description`.
Order: first match wins. Runtime rules (API/CLI) are checked BEFORE config rules; a newly added runtime rule goes first (newest wins). `?position=last` / `--last` appends. Expired (`times`) / disabled / probability-missed rules are skipped, next rule is tried.
Unknown fields are rejected (400) - the error lists allowed fields.

## 4. Config file `mockwire.json` (schema: schema/mockwire.config.schema.json)
```json
{ "upstream": "https://api.example.com", "port": 8899,
  "rules": [ {"name":"x","path":"/a","status":500} ],
  "scenarios": { "empty": { "description": "...", "rules": [ {"path":"/api/**","json":[]} ] } } }
```
Effective order: runtime rules, active scenario rules, base `rules`. File is hot-reloaded; an invalid edit keeps the previous rules and shows in `state.configError`. `mockwire init` writes an example. `mockwire scenario use <n>` is in-memory (file untouched).

## 5. HTTP control API (same port, prefix /__mockwire; JSON in/out; errors `{"error":{"code","message"}}`, 400 validation, 404 unknown)
```
GET    /health
GET    /state                      -> {version,offline,scenario,scenarios[],upstreams[],configPath,configError,requests,rules[]}
GET    /rules          POST /rules (object|array; ?position=last)   DELETE /rules (runtime only)
GET|DELETE|PATCH /rules/:idOrName  (PATCH merges fields e.g. {"enabled":false}; DELETE only runtime rules)
GET    /offline        PUT /offline {"on":true}   PUT /offline/on|off
POST   /reset
GET    /log?tail=N     DELETE /log -> {requests:[{id,time,method,url,mode,upstream,rule,action,status,outcome,ms,error?}],total}
GET    /scenarios      POST /scenarios/:name/use     (PUT /scenario {"name":"x"})
```
Rule object in responses adds `id`, `source` (runtime|scenario|base), `hits`, `remaining`.
`outcome`: ok | dropped | timeout | client_aborted | upstream_error | no_upstream | error.

## 6. Limits / gotchas
- Rules apply in reverse mode (base URL = proxy) and to plain `http://` through forward-proxy mode. `https://` via HTTPS_PROXY/CONNECT is a blind tunnel (no MITM): only `offline` affects it. To fault-inject HTTPS APIs use reverse mode.
- WebSocket/upgrade not proxied. Request bodies are streamed unless some rule uses `bodyContains` (then buffered, max 20MB).
- `modify` only patches JSON responses (content-type contains json); others pass through unchanged.
- Cleartext: Android needs `usesCleartextTraffic` (debug) and iOS needs ATS exception for `http://` proxy URL. See README.
- Control API is unauthenticated; use `--host 127.0.0.1` on shared networks.

## 7. Hosted mode & sessions (real phones, remote testers, CI - not localhost-only)
Run once on a server behind HTTPS (Caddy/nginx): `mockwire serve --token <secret> --upstream dev=https://dev-api.x.com --upstream prod=https://api.x.com --default-upstream dev` (binds 127.0.0.1 by default; `MOCKWIRE_TOKEN` env works too; `--session-ttl <minutes>` default 1440; `--no-trust-proxy`). `serve` refuses to start without a token. X-Forwarded-For is trusted for the client IP in logs.
- Token: control API (`/__mockwire/*`, except `/health`) needs `Authorization: Bearer <token>` (or `X-Mockwire-Token`). Without a configured token, control only works from loopback (requests carrying X-Forwarded-For are rejected with 401). Proxy traffic itself needs no token.
- Session = isolated rules / offline / log / scenario / upstream choice. Use it as a path prefix in the app's base URL: `https://mock.example.com/s/<session>` (works on every platform, no header injection). Alternative: header `X-Mockwire-Session: <session>`. Name: `[A-Za-z0-9_.-]{1,40}`. Unknown sessions are created on demand with no rules (pure passthrough) and deleted after the idle TTL. Requests without a session use `default`.
- CLI: `--url https://mock.example.com --token <t> --session <name>` (or env MOCKWIRE_URL / MOCKWIRE_TOKEN / MOCKWIRE_SESSION). Every command accepts them.
  `mockwire --session alice rule add --path /api/x --status 500`, `mockwire --session alice offline on`, `mockwire --session alice reset`.
- Per-session upstream: `mockwire --session alice upstream use prod` (back: `upstream use default`); PUT `/__mockwire/upstream {"name":"prod"}`. Named upstreams are also reachable by path prefix: `/s/alice/prod/api/...`.
- API: control URL = `<base>/s/<session>/__mockwire/...`; extra endpoints `GET /sessions`, `DELETE /sessions/:name`, `GET|PUT /upstream`. `state.session` / `log[].session` tell which session you are looking at.
- Behind a reverse proxy `drop` / `offline` reach the client as 502 from the proxy (the proxy sees the reset), not as a TCP reset.

### RunnersHi hosted instance
- Base URL (app "서버 선택 > 직접 입력"): `https://runnershi-mock.oguriworks.com/s/<session>` - default upstream = dev API, per-session `upstream use prod` switches to prod.
- CLI: `export MOCKWIRE_URL=https://runnershi-mock.oguriworks.com MOCKWIRE_TOKEN=$RUNNERSHI_MOCKWIRE_TOKEN` (token in ~/.claude/.env), then `npx github:kangraemin/mockwire --session <session> rule add ...`.
- Use a unique session per agent/device (e.g. `ios-handnew`, `android-ci-123`); `reset` when done.
