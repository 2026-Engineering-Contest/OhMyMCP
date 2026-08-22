# @mcpeak/record

MCP 클라이언트를 카세트로 감싸 녹화·재생하고, 테스트 대상 서버가 **밖으로 부르는 HTTP 호출**을
External 세션으로 녹화·재생하며, **이름으로 판정 가능한** 비밀값을 프로세스 밖으로 나가는
경계에서 제거한다 — URL 경로는 이 판정에 안 걸려 External 세션에는 아직 원문으로 남는다
([자세히](#external-세션의-url-경로는-아직-저장된다)).

- **오너:** `@ddxng5` (② replay/record 파트)
- **의존:** `@mcpeak/core`
- **결정:** [ADR-0003](../../docs/adr/0003-cassette-matching-key.md) (개정:
  [ADR-0039](../../docs/adr/0039-민감-키-목록과-매칭-경계.md),
  [ADR-0040](../../docs/adr/0040-스키마와-데이터의-마스킹-규칙-분리.md),
  [ADR-0041](../../docs/adr/0041-마스킹의-적용-경계.md))
- **External 세션 결정:** [ADR-0051](../../docs/adr/0051-external-record-replay와-tool-카세트-경계-분리.md),
  [ADR-0052](../../docs/adr/0052-coordinator가-engine과-session-store를-소유한다.md),
  [ADR-0053](../../docs/adr/0053-http-외부-요청-매칭과-반복-호출-정책.md),
  [ADR-0057](../../docs/adr/0057-external-어댑터는-global-fetch-까지만-가로챈다.md)

## 공개 API

```ts
import {
  cassetteClient,
  loadCassette,
  saveCassette,
  type Cassette,
} from "@mcpeak/record";

const path = "fixtures/weather.cassette.json";
const cassette = await loadCassette(path);

const client = cassetteClient(realClient, {
  cassette,
  cassettePath: path,
  onFlush: (next) => saveCassette(path, next),
});

try {
  const tools = await client.listTools();
  const result = await client.callTool("get_weather", { city: "Seoul" });
  console.log(tools, result);
} finally {
  await client.close();
}
```

## 모드

| 모드 | 동작 |
|---|---|
| `record` | 항상 실제 client를 호출하고 새 카세트를 만든다. |
| `replay` | 카세트에 저장된 `listTools`와 `callTool` 응답만 돌려준다. 누락되면 에러다. |
| `auto` | 카세트에 있으면 재생하고, 없으면 실제 호출 뒤 카세트에 추가한다. |

`mode`를 생략하면 `auto`로 동작한다. `cassettePath`는 파일 IO를 수행하지 않고, 실패 메시지에
표시할 경로로만 사용한다.

### `record` 모드가 지우는 것

`record`는 넘겨받은 `cassette`를 **무시하고 빈 카세트에서 시작한다.** 저장하면 이번 실행이
부른 것만 남고 나머지는 사라진다. 그것이 "다시 녹화한다"의 의미다.

지우는 것은 막지 않되, **말없이 지우지는 않는다.** `record` 모드에서 `onFlush`가 있으면
`close()` 시점에 기존 카세트와 비교해 사라지는 상호작용을 `onWarning`으로 알린다.

```
→ --record 가 기존 카세트의 상호작용 2개를 지웁니다: fixtures/weather.cassette.json
  기존 3개 중 1개는 유지되고, 이번 실행에 없는 2개는 사라집니다.
  사라지는 요청: get_weather({"city":"부산"}), get_weather({"city":"제주"})
  → 이번 실행이 그 케이스를 부르지 않았습니다. 테스트 필터나 중간 실패를 확인하세요.
  → 기존 녹화본을 지키려면 --record 없이 실행하세요. 없는 것만 덧붙습니다.
```

경고일 뿐 저장을 막지 않는다. 막으면 `--record`가 갈아엎으라는 명령이라는 의미가 바뀌고,
`--record`를 자동으로 도는 파이프라인이 깨진다.

경고는 `onFlush`가 성공한 뒤에만 나온다. `onFlush`가 없거나 던지면 파일이 그대로이므로
사라지는 것도 없는데, 그때 "사라집니다"라고 말하면 거짓이 된다.

판정은 아래 두 함수로 분리돼 있고 `cli`가 직접 부를 수도 있다.

```ts
diffCassettes(before: Cassette | null, after: Cassette): CassetteDropReport;
droppedInteractionsMessage(report: CassetteDropReport, cassettePath?: string): string | null;
```

`dropped` 판정은 `key` 기준이다. 같은 키에 응답만 바뀐 것은 손실이 아니라 갱신이므로 세지
않는다. `before`가 `null`이면(새 파일) 사라지는 것이 없다. `auto`는 기존 것을 물려받아
덧붙이므로 이 경고를 내지 않는다.

`close()`는 `onFlush`가 있으면 저장용으로 마스킹한 카세트를 넘긴 뒤 `inner.close()`를
호출한다. 파일 IO는 `loadCassette`와 `saveCassette`로 분리되어 있고, 테스트에서는 `onFlush`에
인메모리 저장 함수를 넣으면 된다.

`inner.close()`는 `onFlush`가 실패해도 `finally`로 항상 실행된다. `onFlush`와
`inner.close()`가 동시에 실패하면 `inner.close()`의 오류가 우선한다 — `onFlush`의 오류는
버려지고 호출자에게 전달되지 않는다 (JS `try`/`finally` 기본 동작).

실제 `listTools` 또는 `callTool` 호출은 성공했지만 결과가 JSON 카세트로 복제될 수 없으면
호출 결과는 그대로 돌려주고, `close()`에서 녹화 실패와 값 경로를 보고한다. 이때 불완전한
카세트를 저장하지 않도록 `onFlush`는 호출하지 않는다.

호출 인자가 JSON 카세트로 표현될 수 없으면 `record`와 `auto` 모드는 실제 호출 결과를 그대로
돌려주고 `close()`에서 녹화 실패를 보고한다. 이때 불완전한 카세트를 저장하지 않도록 `onFlush`는
호출하지 않는다. `replay` 모드는 실제 호출 없이 카세트를 조회할 수 없는 값의 경로와 종류를
보고한다.

## 드리프트 확인 (`verifyCassette`)

`auto` 모드는 카세트에 있는 요청이면 서버를 부르지 않는다. 그래서 **서버 응답이 바뀌어도
영원히 알아채지 못한다.** 그것을 확인하는 방법이 파괴적인 `--record` 뿐이면 재동기화를
피하게 되고, 카세트는 손으로 쓴 목과 똑같이 낡는다. 이 함수가 그 비파괴 경로다.

```ts
import { loadCassette, verifyCassette } from "@mcpeak/record";

const cassette = await loadCassette(path);
if (cassette !== null) {
  const result = await verifyCassette(client, cassette, { cassettePath: path });
  // { matched, mismatched, failed, skipped, toolsChanged }
  for (const item of result.mismatched) console.error(item.message);
}
```

**카세트를 고치지도 저장하지도 않는다.** 연결도 닫지 않는다 — 소유권은 호출자에게 있다.
**CLI 진입점은 제거됐다.** `mcpeak verify` 는 Tool 카세트와 함께 걷어내는 중이라
([ADR-0059](../../docs/adr/0059-tool-카세트를-제거한다.md)), 이 함수는 라이브러리로만 남아 있다.

읽기 전용인 것은 **카세트 파일이지 서버가 아니다.** 녹화된 요청을 전부 다시 호출하므로,
메일 발송·결제·파일 쓰기 같은 툴이 카세트에 있으면 그 부작용이 실제로 다시 일어난다.
부작용이 있는 서버에는 샌드박스에서 붙여라.

| 분류 | 뜻 |
|---|---|
| `matched` | 카세트와 실서버 응답이 같다 |
| `mismatched` | 응답이 달라졌다. 카세트가 낡았다는 뜻이다 |
| `failed` | 실서버 호출 자체가 실패했다. 응답 차이와 구분한다 |
| `skipped` | args 에 마스킹된 값이 있어 실서버에 그대로 보낼 수 없다 |

### 비교는 마스킹 후에 한다

파일에서 읽은 카세트의 응답은 `prepareCassetteForWrite` 를 거쳐 이미 마스킹돼 있고 실서버
응답은 원문이다. 그대로 비교하면 비밀값이 든 응답이 **전부 거짓 불일치**가 된다. 그래서
실서버 응답에 `redact` 를 먼저 걸고 비교한다.

대가로 **비밀값 자체만 바뀐 경우는 감지하지 못한다** — 양쪽 다 `"[redacted]"` 로 보인다.
다만 그 값은 테스트에도 마스킹돼 나가므로([ADR-0041](../../docs/adr/0041-마스킹의-적용-경계.md))
어떤 단언도 그것에 의존할 수 없고, 따라서 놓쳐도 테스트 결과는 달라지지 않는다. 필드 추가·삭제,
이름 변경, 일반 값 변경, `isError` 변경, 툴 스키마 변경은 모두 잡힌다.

요청 **인자**에 비밀값이 있었던 상호작용은 원래 요청을 복원할 수 없다. 마스킹된 값을 실서버에
그대로 보내지 않고 `skipped` 로 보고한다. 그 요청의 드리프트는 `--record` 로만 확인된다.

## 매칭과 저장 규칙

`matchKey(toolName, args)`는 `toolName`과 stable JSON 인자를 SHA-256 hex로 해시한다. 원본
인자는 마스킹 전에 키 계산에 쓰지만, 파일에는 해시만 저장한다. 객체 키 순서는 사전순으로
정렬하고, 객체의 `undefined` 필드는 제거하며, 배열 순서는 유지한다.

카세트는 `version: 1`, `interactions`, 선택적인 `tools`를 가진다. `tools`에는 `listTools`
응답을 저장한다. `replay` 모드에서 `listTools`도 실서버로 나가지 않는다.

같은 키에 다른 응답이 녹화되면 첫 응답을 유지하고 경고한다. 같은 요청에 다른 응답이 오는
서버는 카세트가 숨길 문제가 아니라 결정론성 결함이다.

`replay`에서 키를 찾지 못하면 같은 툴의 저장 요청 중 표시 가능한 인자 차이가 가장 적은 항목과
필드별 차이를 보여준다. 마스킹 후 인자가 동일하면 비밀값 차이 또는 어긋난 키를 구분할 수 있도록
요청 키와 저장 키의 앞 8자를 보여준다.

## 마스킹

`redact(value)`는 키를 `-`·`_` 구분자와 카멜케이스 경계로 단어를 나눈 뒤, **뒤에서부터
이어붙인 접미 조합**이 `authorization`, `apikey`, `accesstoken`, `refreshtoken`, `token`,
`secret`, `password`, `cookie` 중 하나와 정확히 일치하는 필드만 `"[redacted]"`로 바꾼다.
대소문자는 구분하지 않는다. 부분 문자열 포함이 아니라 접미 일치이므로 `tokenCount`·
`passwordPolicy`처럼 머리 명사가 다른 합성어는 마스킹하지 않는다. 반대로 `X-Api-Key`처럼
목록에 없는 단어가 앞단어와 합쳐 목록에 걸리는 경우는 그대로 마스킹한다. 판정 규칙과 한계는
[ADR-0039](../../docs/adr/0039-민감-키-목록과-매칭-경계.md).

`tools`의 `inputSchema`는 데이터가 아니라 스키마라 `redact`가 아닌 별도 규칙
(`redactSchema`)을 탄다. 프로퍼티 이름 자체는 절대 마스킹하지 않고, 민감한 프로퍼티 아래의
`default`·`const`·`examples`·`enum` 값만 가린다. 근거는
[ADR-0040](../../docs/adr/0040-스키마와-데이터의-마스킹-규칙-분리.md).

요청 `args`는 녹화 시점에 마스킹되어 인메모리 카세트에도 원문 비밀값이 남지 않는다. 응답
`content`/`raw`와 `tools`는 재생 결정론성을 위해 **내부 카세트에는** 원문으로 남지만,
`callTool`·`listTools`가 호출자에게 돌려주는 값과 `onFlush`가 받는 저장용 카세트는 이미
마스킹되어 있다 — 값이 프로세스 밖으로 나가는 경계마다 마스킹을 건다
([ADR-0041](../../docs/adr/0041-마스킹의-적용-경계.md)). 값이 JSON 문자열이면 이 경계에서
파싱 가능한 경우 구조화해 마스킹하고 stable JSON 문자열로 저장한다.

## External 세션

**서버가 밖으로 부르는 HTTP 호출**을 녹화·재생한다. 유료 API 나 부작용이 있는 endpoint 를
부르는 서버가 대상이며, 재생할 때도 **서버 자체는 실제로 뜬다** — 멈추는 것은 서버가 아니라
그 서버가 밖에 부르는 쪽이다.

### Tool 카세트와 다른 점

이 패키지에는 그 위에 있는 절들이 다루는 **Tool 카세트**가 이미 있다. 둘 다 "녹화·재생"이라
헷갈리기 쉽지만 겨냥하는 문제가 다르다 — 카세트는 *우리가 서버에게 물어본 것*(서버를 다시
띄우지 않으려고), External 세션은 *그 서버가 밖에 물어본 것*(서버는 띄우되 그 바깥 호출만
멈추려고)을 남긴다.

| | Tool 카세트 | External 세션 |
|---|---|---|
| 남기는 것 | 우리 → 서버 (`listTools`·`callTool`) | 서버 → 외부 API (HTTP) |
| 재생할 때 | 감싼 클라이언트를 부르지 않는다 | **서버는 실제로 돌고**, 그 서버의 외부 호출만 막힌다 |
| CLI | `generate --cassette` (제거 예정) | `test --record-session` · `test --session` |

**Tool 카세트는 legacy 다.** External 이 서버를 실제로 실행하는 더 실제 문제에 가까운 경로라,
[ADR-0051](../../docs/adr/0051-external-record-replay와-tool-카세트-경계-분리.md)은 두 경로가
당분간 공존하되 "일시적인 중복보다 영구적인 의미 혼합이 더 큰 비용"이라고 못박고, 검증이
끝나면 **0.x breaking 변경으로 카세트를 제거한다**고 결과 절에 적어 뒀다. 지금 이 절이 카세트를
나란히 설명하는 것은 두 기능이 대등해서가 아니라, 검증이 끝나기 전까지는 `--cassette` 를 이미
쓰는 사용자가 새 기능과 헷갈리지 않게 하려는 것이다. 새로 시작한다면 카세트가 아니라 External
세션을 볼 자리다.

### 잡는 범위는 `globalThis.fetch` 하나다

첫 어댑터의 이름이 `node.fetch.v1` 이고, 그 이름 안의 `fetch` 가 곧 범위다. 아래는 **범위 밖**이라
녹화도 재생도 되지 않는다.

- `node:http` · `node:https` 직접 호출
- 그 위에 얹힌 axios · got · node-fetch
- Node 가 아닌 서버(Python · Go 등) — 주입이 Node 의 `--import` 훅이라 애초에 닿지 않는다

**범위 밖 호출은 Coordinator 에 도달하지 않는다.** 그래서 재생 중에도 실제 네트워크로 나가고,
막지 못한다. 대신 CLI 가 녹화 0건 · 재생 0건 · 부분 재생 같은 종료 요약으로 그 가능성을 알린다.
범위를 이렇게 정한 이유와 대안 비교는
[ADR-0057](../../docs/adr/0057-external-어댑터는-global-fetch-까지만-가로챈다.md).

### CLI 로 쓰기

**CLI 에서는** 세션 파일 하나가 세션 하나다 — `sessionId` 를 고정값 `"default"` 로 쓴다. Store
자체는 `sessionId` 로 세션을 구분하므로 한 SQLite 파일에 여러 세션을 담을 수 있다(아래 라이브러리
예제 참고). 왕복 예제는 [루트 README](../../README.md#외부-api-를-부르는-서버).

```bash
mcpeak test suite.json --command node --arg ./server.js --record-session weather.session.db
mcpeak test suite.json --command node --arg ./server.js --session weather.session.db
```

### 라이브러리로 쓰기

`@mcpeak/record/external` 이 공개하는 것은 Store 와 Coordinator 둘이다. Coordinator 가 자식에게
실어 줄 환경 변수를 만들고, 그 환경 변수로 뜬 자식의 `fetch` 가 녹화·재생된다.

```ts
import { createSqliteSessionStore, startExternalCoordinator } from "@mcpeak/record/external";

const store = createSqliteSessionStore({ path: "weather.session.db" });
const handle = await startExternalCoordinator({
  mode: "record",
  sessionId: "default",
  store,
});

let status: "completed" | "failed" = "completed";
try {
  // handle.childEnvironment 를 그대로 자식 프로세스의 env 에 실어 띄운다.
  await runServerWith(handle.childEnvironment);
} catch (error) {
  status = "failed";
  throw error;
} finally {
  try {
    const summary = await handle.finish(status);
    console.log(summary.interactionCount);
  } finally {
    store.close();
  }
}
```

재생은 `{ mode: "replay", sourceSessionId, store }` 로 연다. `finish()` 를 **성공·실패 어느
경로에서도 부르고**, 그 뒤에 `store.close()` 한다 — 안 부르면 SQLite 파일 핸들이 남고 녹화 세션이
`running` 인 채로 남아 다음 실행이 이어 쓸 수 없다. 반환된 요약의 `interactionCount` ·
`consumedCount` · `unusedCount` 가 CLI 종료 알림의 근거다.

### `node:sqlite` 실험 경고

External 세션은 `node:sqlite` 로 저장한다. Node 가 이 모듈을 아직 실험적으로 표시하므로,
런타임에 따라 stderr 에 경고가 한 줄 찍힌다.

```
(node:2845) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

**프로세스에서 `node:sqlite` 를 처음 로드하는 순간 한 번** 나온다. 세션 하나당도, 호출
하나당도 아니다 — 모듈 로드는 프로세스에서 한 번뿐이라 한 프로세스가 세션을 여러 개 열어도
줄은 하나다. `mcpeak test` 한 번은 프로세스 하나이므로 실행당 최대 한 줄이 된다.

실측한 것은 두 버전이다.

| 런타임 | |
|---|---|
| Node 22.18.0 | 경고가 나온다 |
| Node 24.16.0 | 나오지 않는다 |

그 사이 버전은 재지 않았다. 경고가 어느 패치에서 빠졌는지 모르므로 "22 대는 나오고 24 대는
안 나온다" 로 일반화하지 않는다.

이 경고는 **Node 의 API 표면**에 대한 것이지 저장된 녹화에 대한 것이 아니다. 파일은 헤더가
`SQLite format 3` 인 표준 SQLite 라서 다른 도구로도 열리고, Node 가 바인딩을 바꿔도 그대로
읽힌다. 경고를 지우지 않는 이유와 범위를 좁힌 방법은
[ADR-0056](../../docs/adr/0056-node-sqlite-실험-경고를-external-사용자에게만-보인다.md).

### External 세션은 URL 경로를 저장하지 않는다

마스킹은 **이름**으로 판정한다. URL 경로 세그먼트에는 판정에 쓸 이름이 없어서, 이름 기반
마스킹으로는 무엇이 비밀인지 가릴 수 없다. 그래서 matchKey 를 계산한 **뒤**, 저장 직전에
pathname 을 통째로 지운다.

```
https://hooks.example.com/services/T000/B111/XXXXsecret?token=abc
        ↓ 저장되는 값
https://hooks.example.com/<redacted>?token=[redacted]
```

**표준 URL 필드 넷**에 같은 규칙이 적용된다. `location`·`content-location` 은 상대 참조(RFC
9110, `Location: /hooks/SECRET`)여도 거부하지 않고 응답 URL 기준으로 절대 URL 로 해석한 뒤
같은 규칙으로 지운다.

| 자리 | 적용 |
|---|---|
| 요청 `display.url` | pathname → `<redacted>` |
| 저장 outcome `url` | 위와 같다 |
| `location` 헤더 | 절대 URL 로 해석 후 pathname → `<redacted>` |
| `content-location` 헤더 | 위와 같다 |

matchKey 계산에 쓰는 정확한 pathname(매칭 재료)은 **자식 프로세스 밖으로 나가지 않는다** —
Coordinator 로 보내지도, Store 에 실리지도 않는다. `/hooks/AAA` 와 `/hooks/BBB` 는 여전히
다른 matchKey 를 낸다. pathname 이 없어도 매칭 정확도가 변하지 않는 이유다.

**이 넷이 전부는 아니다.** JSON body 안의 URL 문자열(pagination 의 `next`, HATEOAS 링크)과
`Link`(RFC 8288)·`Refresh` 헤더에는 경로가 그대로 남는다. 값의 이름으로 판정할 수 없는 자리라
ADR-0053 도 이들을 보장 범위 밖으로 둔다. **자격증명이 어디에 실려 나가든 아래 정리 절차는
똑같이 적용된다.**

Slack·Discord webhook처럼 **경로 자체가 자격증명**인 endpoint를 녹화해도, 그 값은 위 넷에서는
남지 않는다. 다만 그 endpoint 가 JSON body 나 `Link`/`Refresh` 헤더로 자기 URL 을 되돌려주면
그 자리로는 여전히 샐 수 있다 — 녹화한 세션 파일을 커밋하기 전에는 내용을 확인해라.

**이 절 위에 있던 서술("URL 경로가 원문으로 저장된다")은 ADR-0053 의 구현 PR 이전 버전에
해당한다.** 그 시점에 만든 세션 파일에는 경로가 원문으로 남아 있으므로, 아래 정리 절차가
여전히 필요하다.

### 세션 파일에 자격증명이 들어갔을 때

이 문서의 이전 버전(경로 제거 구현 이전)에서 녹화한 세션에는 경로가 원문으로 들어 있다.
**파일을 지우는 것으로 끝나지 않는다.**

1. 세션 파일을 삭제한다.
2. 노출된 자격증명을 **폐기하고 재발급한다.** 커밋했다면 파일을 지워도 git 히스토리에
   남아 있으므로, 그 값은 이미 노출된 것으로 다뤄야 한다.
3. 새 자격증명으로 다시 녹화한다.

## 제외 범위

첫 버전은 사용자 정의 매칭 함수, 사용자 정의 마스킹 규칙, TTL, 부분 매칭을 제공하지 않는다.
필요성이 확인되면 별도 ADR로 확장한다.

**계약 스냅샷(`snapshotContract`)과 비결정 필드 제거도 제공하지 않는다.** 이 패키지는
비결정성을 지워서 감추지 않고, 같은 키에 다른 응답이 오면 경고해서 드러낸다. 실행 간
차이를 판정하는 일은 `runner` 의 결정론성 확인이 맡는다
([ADR-0038](../../docs/adr/0038-결정론성-확인의-비교-대상과-캡처-위치.md)). 근거는
[ADR-0047](../../docs/adr/0047-계약-스냅샷-api-철회.md).
