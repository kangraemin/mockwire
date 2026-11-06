# mockwire

모든 클라이언트(Android / iOS / 웹 / React Native / Flutter / 데스크톱)가 쓰는 **HTTP 목(mock) · 장애 주입 프록시**. 의존성 0, Node >= 18.
앱의 base URL을 프록시로 바꾸면, 규칙에 걸린 요청은 가짜 응답 / 500 / 지연 / 연결 끊김 / 무응답을 받고 나머지는 실서버로 그대로 간다. AI 에이전트가 CLI와 JSON 제어 API로 바로 조작하도록 설계했다 ([AGENTS.md](AGENTS.md), [llms.txt](llms.txt)).

*English: an HTTP mock / fault-injection reverse proxy (plus plain-HTTP forward proxy and CONNECT passthrough) with zero dependencies. Point your app's base URL at it; matching requests get mocks, 5xx, latency, dropped connections, hangs or an "offline" switch, everything else is forwarded to the real server. Built to be driven by AI agents via CLI / HTTP control API. Full reference: [AGENTS.md](AGENTS.md).*

## 시작

```bash
npx github:kangraemin/mockwire start --upstream https://api.example.com --port 8899
# 또는 클론해서
node bin/mockwire.js start --upstream https://api.example.com
# 규칙/시나리오 파일로
node bin/mockwire.js init            # mockwire.json 예제 생성
node bin/mockwire.js start           # ./mockwire.json 자동 사용 (저장하면 핫 리로드)
```

시작하면 플랫폼별 접속 주소를 출력한다. 요청은 한 줄씩 로그: `12:00:01 GET /api/terms -> 500 status 0ms rule=ranking-500`.

## 규칙 조작 (실행 중인 프록시에 CLI로, 모든 명령 `--json` 지원)

```bash
mockwire rule add --method GET --path /api/ranking --status 500       # 서버 에러
mockwire rule add --path /api/me --body-json '{"name":"test"}'        # 목 데이터
mockwire rule add --path '/api/**' --delay 5000                       # 느린 응답
mockwire rule add --path /api/x --drop                                # 연결 끊김
mockwire rule add --path /api/x --timeout                             # 무한 대기
mockwire rule add --path /api/terms --set '$.data[0].version=99'      # 실응답 일부만 수정
mockwire offline on                                                   # 인터넷 끊김 (전체)
mockwire scenario use empty                                           # mockwire.json 의 시나리오 전환
mockwire log --tail 20 --json                                         # 앱이 실제로 보낸 요청 + 걸린 규칙
mockwire reset                                                        # 전부 초기화
```

규칙 스키마, 제어 API, 우선순위는 [AGENTS.md](AGENTS.md), 설정 파일 스키마는 [schema/mockwire.config.schema.json](schema/mockwire.config.schema.json), 예제는 [examples/mockwire.json](examples/mockwire.json).
핵심: 첫 매치가 이긴다. API/CLI로 추가한 규칙이 설정 파일 규칙보다 먼저, 그중에서도 나중에 추가한 게 먼저 적용된다(`--last`로 뒤에 추가).

## 플랫폼별 설정 (base URL을 프록시로)

| 환경 | base URL |
|---|---|
| iOS 시뮬레이터 / 웹 / 데스크톱 | `http://localhost:8899` |
| Android 에뮬레이터 | `http://10.0.2.2:8899` |
| 실기기 (같은 Wi-Fi) | `http://<맥 LAN IP>:8899` (시작 시 출력됨) |

프록시는 `http://`라서 디버그 빌드에서만 평문 허용을 켠다.

**Android (에뮬레이터 10.0.2.2)** - `app/src/debug/AndroidManifest.xml`
```xml
<application android:usesCleartextTraffic="true" android:networkSecurityConfig="@xml/network_security_config" />
```
`app/src/debug/res/xml/network_security_config.xml`
```xml
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">192.168.0.10</domain> <!-- 실기기: 맥 LAN IP -->
  </domain-config>
</network-security-config>
```

**iOS (시뮬레이터 localhost)** - 디버그 빌드의 Info.plist (시뮬레이터/로컬 주소만이면 이것만)
```xml
<key>NSAppTransportSecurity</key>
<dict><key>NSAllowsLocalNetworking</key><true/></dict>
```
실기기에서 LAN IP를 쓰면 `NSAllowsLocalNetworking`으로 대개 충분하다. 안 되면 디버그 전용으로 `NSAllowsArbitraryLoads` = true 또는 `NSExceptionDomains` 에 해당 IP를 추가한다. 릴리스 빌드에는 넣지 않는다. 실기기 첫 실행 시 "로컬 네트워크" 권한 팝업을 허용해야 한다.

**웹** - base URL만 `http://localhost:8899`로. CORS preflight(`OPTIONS`)는 프록시가 직접 응답하고, 모든 응답에 `Origin`을 반사한 CORS 헤더를 붙인다(`--no-cors`로 끔). https 페이지에서 http 프록시 호출은 mixed content로 막히니 로컬 dev 서버(http)에서 쓴다.

**React Native** - 환경 변수/설정의 API base를 플랫폼별로: `Platform.OS === 'android' ? 'http://10.0.2.2:8899' : 'http://localhost:8899'`. Android는 위 cleartext 설정, iOS는 ATS 설정(Expo는 `app.json`의 `ios.infoPlist`, `android.usesCleartextTraffic` / `expo-build-properties`).

**Flutter** - `Platform.isAndroid ? 'http://10.0.2.2:8899' : 'http://localhost:8899'` 를 `Dio(BaseOptions(baseUrl: ...))` 등에. 플랫폼 설정은 각각 Android/iOS와 같다(`android/app/src/debug`, `ios/Runner/Info.plist`).

## 모드와 한계

- **리버스 프록시(권장)**: base URL을 프록시로. 모든 규칙 동작. 업스트림이 https여도 된다(프록시가 TLS로 접속).
- **포워드 프록시**: 기기/시스템 프록시를 `맥IP:8899`로 지정하면 `http://` 요청에 규칙이 적용된다. `https://`는 `CONNECT` 터널로 그대로 통과만 한다(MITM 없음, 인증서 설치 없음) -> 내용 규칙은 적용 불가, `offline`만 터널을 끊는다. https API를 건드리려면 리버스 모드를 쓴다.
- 업스트림 여러 개: `--upstream https://main.com --upstream auth=https://auth.com` -> `/auth/...`는 auth로 간다(접두사 제거).
- WebSocket은 프록시하지 않는다. 제어 API는 인증이 없으니 공용 네트워크에서는 `--host 127.0.0.1`.

## 개발

```bash
npm test                 # node:test, 외부 의존 없음
node scripts/smoke.js https://api.example.com /path    # 실서버 스모크 (통과 -> 목 -> 500 -> drop -> offline)
```

MIT
