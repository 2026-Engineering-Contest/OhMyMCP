import type {
  HttpBody,
  JsonValue,
  NormalizedExternalRequest,
  StoredExternalOutcome,
  StoredHttpResponse,
  StoredHttpThrow,
} from "./protocol.js";

export const HTTP_MATCH_KEY_DOMAIN: "mcpeak.external.http";
export const HTTP_INTERACTION_SCHEMA_VERSION: 1;
/** H1 이 지원하는 method. 자식의 정규화와 부모의 검사가 같은 값을 봐야 한다. */
export const SUPPORTED_HTTP_METHODS: readonly string[];

/**
 * matchKey 계산에만 쓰는 재료(ADR-0053 `HttpMatchMaterialV1`). 정확한 pathname 을 담으므로
 * **자식 프로세스 밖으로 나가지 않는다** — `normalizeHttpRequest` 가 내부에서 만들어 해싱한
 * 뒤 버리고, 반환값(`NormalizedExternalRequest`)에는 이 모양이 실리지 않는다. `protocol.ts`
 * 가 export 하는 `HttpDisplayV1` 과 필드가 같아 보여도 값의 출처가 다르다.
 *
 * **이 모듈의 어떤 export 도 이 타입을 돌려주지 않는다.** 받는 쪽은 `httpMatchKey` 하나뿐이고
 * 그것은 해시 문자열을 돌려준다 — 재료가 밖으로 나갈 문이 없다는 뜻이다. 한때
 * `cloneHttpMatch(value: HttpMatchMaterialV1): HttpMatchMaterialV1` 이 그 문이었다. 호출자가
 * 없는 죽은 코드였지만, 같은 디렉터리의 코드가 상대 경로로 불러다 쓰면 이 규칙이 조용히
 * 무너지는 자리라 지웠다. 여기에 재료를 반환하는 export 를 다시 더하지 마라.
 */
export interface HttpMatchMaterialV1 {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: HttpBody;
}

export function stableStringify(value: unknown): string;
export function httpMatchKey(match: HttpMatchMaterialV1): string;
export function sensitiveKey(key: string): boolean;
export function redactJson(value: JsonValue): JsonValue;
export function normalizeHttpRequest(request: Request): Promise<NormalizedExternalRequest>;
export function encodeHttpResponse(response: Response): Promise<StoredHttpResponse>;
export function encodeHttpThrow(error: unknown): StoredHttpThrow;
export function restoreHttpOutcome(outcome: StoredExternalOutcome): Response;
export function redactNormalizedRequest(
  request: NormalizedExternalRequest,
): NormalizedExternalRequest;
export function redactStoredOutcome(outcome: StoredExternalOutcome): StoredExternalOutcome;
