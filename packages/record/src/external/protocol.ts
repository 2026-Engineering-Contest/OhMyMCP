/**
 * HTTP interaction schema version 의 단일 정의처는 `runtime.mjs` 다. matchKey 해싱과 민감
 * 키 목록 버전에 실제로 쓰는 그 상수를 여기서 재수출한다 — 예전에는 이 파일이
 * `HTTP_ADAPTER_SCHEMA_VERSION` 이라는 이름으로 같은 값 `1` 을 따로 선언해 두고 있었다.
 * 두 상수가 우연히 같은 값이라 지금까지는 드러나지 않았지만, 한쪽만 올리면 타입은 초록인
 * 채로 버전 축이 갈라진다 — `shared/limits.mjs` 가 크기 상한에서 경고하는 것과 같은 함정이다.
 */
import type { HTTP_INTERACTION_SCHEMA_VERSION } from "./runtime.mjs";

export const PROTOCOL_SCHEMA_VERSION = 1 as const;
export { MAX_COORDINATOR_PAYLOAD_BYTES, MAX_HTTP_BODY_BYTES } from "../shared/limits.mjs";
export { HTTP_INTERACTION_SCHEMA_VERSION } from "./runtime.mjs";
export const DEFAULT_COORDINATOR_TIMEOUT_MS = 5_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type HttpBody =
  | { readonly kind: "none" }
  | { readonly kind: "json"; readonly value: JsonValue };

/**
 * 노출 마스킹을 통과한 표시용 HTTP 요청 형태다(ADR-0053 `HttpDisplayV1`). matchKey 계산에
 * 쓰는 매칭 재료(정확한 pathname 을 담는 `HttpMatchMaterialV1`)는 이 타입과 필드가 같아도
 * **자식 프로세스 밖으로 나가지 않는다** — Coordinator wire 와 Store 에 실리는 요청에는 그
 * 재료를 실을 자리 자체가 없다. 매칭 재료 타입은 `runtime.d.mts` 에만 있고, 여기서 export
 * 하지 않는다.
 */
export interface HttpDisplayV1 {
  readonly method: string;
  /** `https://host/<redacted>?page=2` — 경로만 지우고 scheme·host·query 는 남긴다. */
  readonly url: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: HttpBody;
}

export interface NormalizedExternalRequest {
  readonly protocol: "http";
  readonly interactionSchemaVersion: typeof HTTP_INTERACTION_SCHEMA_VERSION;
  readonly matchKey: string;
  readonly display: HttpDisplayV1;
}

export interface StoredHttpResponse {
  readonly kind: "response";
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly url: string;
  readonly body: JsonValue;
}

/**
 * `fetch` 자체가 던진 오류의 저장 형태다. 런타임이 만든 자유 텍스트(`message`·`stack`·
 * `cause`)는 **담지 않는다**(ADR-0053).
 *
 * 자유 텍스트에는 키 기반 마스킹이 작동하지 않는 것이 이유다. 네트워크 오류 문구에는
 * 실패한 URL 이 통째로 들어가는 경우가 흔하고, 그 URL 의 query 에 token 이 있으면
 * 그대로 세션에 남는다. 마스킹은 키를 보고 값을 지우는데 여기엔 키가 없다.
 *
 * 그래서 저장하는 것은 **닫힌 열거형뿐**이다. 값의 집합이 유한하므로 새는 경로가 없다.
 */
export type HttpFailureKind =
  | "abort"
  | "timeout"
  | "dns"
  | "connection"
  | "tls"
  | "network"
  | "unknown";

export type HttpFailureName = "Error" | "TypeError" | "AbortError";

export type HttpFailureCode =
  | "ABORT_ERR"
  | "CERT_HAS_EXPIRED"
  | "DEPTH_ZERO_SELF_SIGNED_CERT"
  | "EAI_AGAIN"
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "ENOTFOUND"
  | "ERR_TLS_CERT_ALTNAME_INVALID"
  | "ETIMEDOUT"
  | "SELF_SIGNED_CERT_IN_CHAIN"
  | "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  | "UND_ERR_CONNECT_TIMEOUT";

export interface StoredHttpThrow {
  readonly kind: "throw";
  readonly failureKind: HttpFailureKind;
  readonly name: HttpFailureName;
  readonly code?: HttpFailureCode;
}

export type StoredExternalOutcome = StoredHttpResponse | StoredHttpThrow;

export interface BeginRecordRequest {
  readonly schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
  readonly request: NormalizedExternalRequest;
}

export interface CompleteRecordRequest {
  readonly schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
  readonly interactionId: string;
  readonly outcome: StoredExternalOutcome;
}

export interface ReplayLookupRequest {
  readonly schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
  readonly request: NormalizedExternalRequest;
}
