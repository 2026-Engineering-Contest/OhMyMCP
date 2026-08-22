/**
 * External Record/Replay 의 오류 타입 **정본**이다. `.ts` 가 아니라 `.mjs` 인 이유가 이 파일의
 * 존재 이유다.
 *
 * `runtime.mjs` 는 자식 프로세스 안에서도 돈다(Bootstrap 이 번들 없이 그대로 로드한다). 그래서
 * `.ts` 를 import 할 수 없다 — 소스 그대로 실행되는 경로에서는 `./errors.js` 라는 파일이
 * 존재하지 않는다. 그 제약 때문에 한때 `runtime.mjs` 는 오류를 **직접 만들어** 썼다:
 *
 * ```js
 * const error = new Error(message);
 * error.name = "ExternalRecordReplayError";   // 이름만 같은 가짜다
 * error.code = code;
 * ```
 *
 * 이름과 `code` 는 같지만 **`ExternalRecordReplayError` 의 인스턴스가 아니다.** 그래서 부모의
 * `coordinator.ts` 가 `error instanceof ExternalRecordReplayError` 로 분기하는 자리에서 이
 * 오류만 조용히 빠져나가, 400 대신 500 `COORDINATOR_INTERNAL` 이 나가고 **ADR-0052 가 요구한
 * "불변식이 깨지면 세션을 즉시 실패로 닫는다" 도 건너뛰었다.** 세션이 `running` 으로 남아,
 * 자식이 다시 보내면 통과할 수 있는 상태가 된다 — 그 분기가 막으려던 바로 그 상황이다.
 *
 * 그 `instanceof` 가 성립해야 하는 자리는 **부모 프로세스 안**이다. `runtime.mjs` 는 자식만의
 * 코드가 아니다 — `coordinator.ts` 가 `redactNormalizedRequest`·`redactStoredOutcome` 을 import
 * 해 Store 직전 재검사에 쓰므로 부모 안에서도 실행되고, 거기서 던진 오류를 같은 부모의
 * `coordinator.ts` 가 받는다. 그러므로 `runtime.mjs` 가 던지는 클래스와 `coordinator.ts` 가
 * 검사하는 클래스는 **한 프로세스 안의 같은 모듈**이어야 하고, `runtime.mjs` 가 import 할 수
 * 있는 형식은 `.mjs` 뿐이다. 그래서 정본이 여기다.
 *
 * 부모와 자식 **사이**에는 `instanceof` 가 애초에 없다. 둘은 별개 프로세스이고 오류는 HTTP
 * JSON 의 `code` 문자열로만 건너간다. 자식(`child/coordinator-client.mjs`)이 이 클래스를 쓰는
 * 이유는 instanceof 가 아니라 **한 패키지에 오류 형태가 두 벌 있지 않게** 하기 위해서다 —
 * 가짜 오류를 만드는 코드가 남아 있으면 다음 사람이 그것을 복사한다.
 *
 * `errors.ts` 는 이 파일을 그대로 다시 내보내는 껍데기로 남는다 — 기존 소비자
 * (`coordinator.ts` 등 5곳)의 import 경로를 바꾸지 않기 위해서다.
 *
 * `shared/limits.mjs` · `shared/sensitive-keys.mjs` 가 같은 형태다: `.ts` 와 `.mjs` 양쪽에서
 * import 해야 하는 것은 `.mjs` 한 곳에 두고 `.d.mts` 로 타입을 붙인다.
 */

export class ExternalRecordReplayError extends Error {
  name = "ExternalRecordReplayError";

  /**
   * `code` 는 의도적으로 쓰기 가능하다. `runtime.mjs` 의 `encodeHttpResponse` 가 요청 body 용
   * 오류를 응답 쪽 code 로 바꿔 다시 던지는 자리가 하나 있다(`UNSUPPORTED_HTTP_BODY` →
   * `UNSUPPORTED_HTTP_RESPONSE`). `.d.mts` 에서는 `readonly` 로 선언해 TS 소비자가 고치는 것은
   * 막는다 — 고칠 수 있어야 하는 것은 그 한 자리뿐이고 거기는 타입 검사를 받지 않는다.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function externalError(code, message) {
  throw new ExternalRecordReplayError(code, message);
}
