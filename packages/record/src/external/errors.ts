/**
 * 오류 타입의 **정본은 `errors.mjs`** 다. 이 파일은 기존 소비자의 import 경로를 유지하기 위한
 * 재수출 껍데기다.
 *
 * 정본이 `.mjs` 인 이유는 `runtime.mjs` 가 자식 프로세스에서 번들 없이 그대로 로드되기 때문이다
 * — `.ts` 를 import 할 수 없다. 클래스가 두 곳에 따로 있으면 `instanceof` 가 성립하지 않고,
 * 실제로 그 때문에 부모의 오류 분기가 조용히 빠져나가는 결함이 있었다. 자세한 배경은
 * `errors.mjs` 의 주석에 있다.
 */
export type { ExternalErrorCode } from "./errors.mjs";
export { ExternalRecordReplayError, externalError } from "./errors.mjs";
