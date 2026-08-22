import { createHash } from "node:crypto";
import { MAX_HTTP_BODY_BYTES } from "../shared/limits.mjs";
import { sensitiveKeyIn, sensitiveKeysOf } from "../shared/sensitive-keys.mjs";
import { externalError } from "./errors.mjs";

const REDACTED = "[redacted]";
const MATCH_HEADER_NAMES = new Set(["accept", "accept-language", "content-type", "range"]);
/**
 * 단어 규칙(`sensitiveKey`)만으로는 걸리지 않는 표준 헤더들. 접미 단어열이 `authorization`
 * 이나 `authenticate` 라 민감 키 목록에 없기 때문이다.
 *
 * `*-authenticate` 계열은 값 자체가 비밀은 아니지만 Digest 인증의 nonce 와 realm 이
 * 들어간다. 녹화본은 커밋되거나 공유되므로 보수적으로 지운다.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "authentication-info",
  "proxy-authentication-info",
]);
export const HTTP_MATCH_KEY_DOMAIN = "mcpeak.external.http";
export const HTTP_INTERACTION_SCHEMA_VERSION = 1;

/**
 * External 은 **자기 interaction schema version 의 스냅샷**을 쓴다. 최신을 따라가면
 * 목록에 단어가 추가되는 순간 이미 저장된 세션의 matchKey 가 바뀌어 전부 miss 가 된다.
 */
const SENSITIVE_KEYS = sensitiveKeysOf(HTTP_INTERACTION_SCHEMA_VERSION);

/**
 * **정본 오류 클래스로 던진다.** 한때 이 자리에서 `new Error()` 에 `name` 과 `code` 만 얹어
 * 모양을 흉내 냈는데, 그 값은 `ExternalRecordReplayError` 의 인스턴스가 아니라서 부모의
 * `error instanceof ExternalRecordReplayError` 분기를 빠져나갔다 — 400 대신 500 이 나가고
 * 세션이 실패로 닫히지도 않았다(ADR-0052). 배경은 `errors.mjs` 주석 참고.
 */
const fail = externalError;

export const sensitiveKey = (key) => sensitiveKeyIn(SENSITIVE_KEYS, key);

const setOwn = (target, key, value) => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const plainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const normalizeJson = (value, redact, active = new Set()) => {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("REQUEST_INVALID", "JSON에 유한하지 않은 숫자가 있습니다.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (!Array.isArray(value) && !plainObject(value))
    fail("REQUEST_INVALID", "JSON으로 저장할 수 없는 값입니다.");
  if (active.has(value)) fail("REQUEST_INVALID", "순환 참조는 JSON으로 저장할 수 없습니다.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          fail("REQUEST_INVALID", "sparse array는 JSON으로 저장할 수 없습니다.");
        const item = value[index];
        result.push(item === undefined ? null : normalizeJson(item, redact, active));
      }
      return result;
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined && !(redact && sensitiveKey(key))) continue;
      const child =
        redact && sensitiveKey(key) ? REDACTED : normalizeJson(value[key], redact, active);
      setOwn(result, key, child);
    }
    return result;
  } finally {
    active.delete(value);
  }
};

export const redactJson = (value) => normalizeJson(value, true);

export const stableStringify = (value) => JSON.stringify(normalizeJson(value, false));

const decodeQueryKey = (value) => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
};

const redactQuery = (search) => {
  if (search === "") return "";
  return search
    .slice(1)
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=");
      const rawKey = separator < 0 ? part : part.slice(0, separator);
      if (!sensitiveKey(decodeQueryKey(rawKey))) return part;
      return `${rawKey}=%5Bredacted%5D`;
    })
    .join("&");
};

/** 경로가 지워졌다는 표식. 여기서 만든 URL 만 자식 밖으로 내보낸다(ADR-0053). */
const REDACTED_PATH = "<redacted>";

const parseNormalizedUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("UNSUPPORTED_HTTP_URL", "외부 HTTP 요청 URL은 절대 URL이어야 합니다.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    fail("UNSUPPORTED_HTTP_URL", "외부 요청은 http 또는 https URL만 지원합니다.");
  if (parsed.username !== "" || parsed.password !== "")
    fail("UNSUPPORTED_HTTP_URL", "URL에 포함된 자격증명은 지원하지 않습니다.");
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  )
    parsed.port = "";
  parsed.search = redactQuery(parsed.search);
  return parsed;
};

/**
 * matchKey 계산에만 쓴다. **정확한 pathname 을 담으므로 반환값을 이 모듈 밖으로 내보내지
 * 않는다** — 호출자는 `normalizeHttpRequest` 안의 `match` 지역 변수 하나뿐이다.
 */
const matchUrl = (rawUrl) => {
  const parsed = parseNormalizedUrl(rawUrl);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
};

/**
 * 노출 마스킹. pathname 을 지운다(ADR-0053) — 경로 세그먼트에는 마스킹 판정에 쓸 이름이
 * 없어 무엇이 비밀인지 가릴 수 없고, webhook 형태(`/services/T…/B…/XXXX`)는 경로 자체가
 * 자격증명이다. `rawUrl` 이 이미 지워진 경로를 담고 있어도(재검사의 재적용) 이 함수는
 * pathname 을 읽지 않으므로 멱등이다.
 */
const pathRedactedUrl = (rawUrl) => {
  const parsed = parseNormalizedUrl(rawUrl);
  return `${parsed.protocol}//${parsed.host}/${REDACTED_PATH}${parsed.search}`;
};

const jsonContentType = (value) => {
  const [mediaType = "", ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) return false;
  for (const parameter of parameters) {
    if (parameter.startsWith("charset=") && parameter !== "charset=utf-8") return false;
  }
  return true;
};

const bytesAsJson = (bytes, contentType, direction) => {
  if (bytes.byteLength > MAX_HTTP_BODY_BYTES)
    fail("HTTP_BODY_TOO_LARGE", `${direction} body가 1 MiB 상한을 초과했습니다.`);
  if (!jsonContentType(contentType))
    fail("UNSUPPORTED_HTTP_BODY", `${direction} body는 UTF-8 JSON만 지원합니다.`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("UNSUPPORTED_HTTP_BODY", `${direction} body가 유효한 UTF-8이 아닙니다.`);
  }
  try {
    return redactJson(JSON.parse(text));
  } catch (error) {
    if (error?.code !== undefined) throw error;
    fail("UNSUPPORTED_HTTP_BODY", `${direction} body가 유효한 JSON이 아닙니다.`);
  }
};

const normalizedHeaders = (headers) => {
  const match = {};
  const display = {};
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    const value = rawValue.trim();
    if (MATCH_HEADER_NAMES.has(name)) setOwn(match, name, [value]);
    setOwn(display, name, MATCH_HEADER_NAMES.has(name) ? [value] : [REDACTED]);
  }
  return { match, display };
};

/**
 * matchKey 는 정규화한 `match` 를 그대로 해싱하지 않고 **envelope 로 감싸서** 해싱한다
 * (ADR-0053 `HttpMatchKeyEnvelopeV1`).
 *
 * `domain` 은 legacy Tool 카세트와 External 의 해시 입력 공간을 구조적으로 분리한다. 두
 * 로더는 상대 형식을 받아들이지 않으므로, 우연히 같은 값이 나와도 서로의 카세트를 집지
 * 않는다.
 *
 * `schemaVersion` 이 해시 **입력** 에 들어가는 것이 핵심이다. 형제 필드로만 두면 정규화
 * 규칙이 version 2 에서 바뀌어도 같은 요청이 같은 matchKey 를 내고, version 1 세션에
 * version 2 요청이 hit 해서 **잘못된 응답을 Replay** 한다. 입력에 넣으면 version 이
 * 달라지는 순간 키 공간이 통째로 갈라져 그 사고가 구조적으로 불가능해진다.
 */
export const httpMatchKey = (match) =>
  createHash("sha256")
    .update(
      stableStringify({
        domain: HTTP_MATCH_KEY_DOMAIN,
        schemaVersion: HTTP_INTERACTION_SCHEMA_VERSION,
        match,
      }),
      "utf8",
    )
    .digest("hex");

/**
 * H1 이 지원하는 method. **부모도 이 집합으로 자식이 보낸 값을 검사한다**(`coordinator.ts`).
 * 두 곳에 따로 적어 두면 지원 범위를 넓힐 때 한쪽만 바뀌어, 자식은 보내는데 부모가 거절하거나
 * 그 반대가 된다. 여기 한 곳에 둔다 — `shared/limits.mjs` 가 크기 상한에서 쓰는 것과 같은 이유다.
 */
export const SUPPORTED_HTTP_METHODS = Object.freeze(["GET", "POST"]);

export async function normalizeHttpRequest(request) {
  const method = request.method.toUpperCase();
  if (!SUPPORTED_HTTP_METHODS.includes(method))
    fail("UNSUPPORTED_HTTP_METHOD", `외부 HTTP 요청 method '${method}'은 지원하지 않습니다.`);
  const headers = normalizedHeaders(request.headers);
  let body = { kind: "none" };
  if (request.body !== null) {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    body = {
      kind: "json",
      value: bytesAsJson(bytes, request.headers.get("content-type") ?? "", "request"),
    };
  }
  // 매칭 재료(HttpMatchMaterialV1). 정확한 pathname 을 담는다 — matchKey 를 얻는 즉시 버리고
  // Coordinator 로 보내지 않는다(ADR-0053). 이 함수의 지역 변수로만 산다.
  const match = {
    method,
    url: matchUrl(request.url),
    headers: headers.match,
    body,
  };
  return {
    protocol: "http",
    interactionSchemaVersion: HTTP_INTERACTION_SCHEMA_VERSION,
    matchKey: httpMatchKey(match),
    display: {
      method,
      url: pathRedactedUrl(match.url),
      headers: headers.display,
      body,
    },
  };
}

/**
 * `response.redirected` 는 런타임이 **자동으로** 따라간 경우에만 참이다. 서버 코드가
 * `redirect: "manual"` 로 부르면 이 다섯 상태 코드가 `redirected === false` 인 채로
 * 돌아오고, JSON 본문을 달고 있으면 아래 검사를 모두 통과해 그대로 저장될 뻔했다 — 그
 * 응답의 `Location` 은 경로가 든 절대 URL 이라, 지우려던 경로가 응답 쪽으로 되돌아온다.
 * 그래서 `redirected` 값과 무관하게 이 다섯 개를 거부한다(ADR-0053). `300`·`304` 는
 * 리다이렉트가 아니므로 대상이 아니다.
 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** URL 값을 담는 응답 헤더. 이름 기반 민감 키 판정에 걸리지 않아 별도 취급이 필요하다. */
const URL_PATH_HEADER_NAMES = new Set(["location", "content-location"]);

/**
 * **전송 표현**을 설명하는 헤더라 저장하지 않는다. `fetch` 가 돌려준 body 는 이미 압축이 풀리고
 * chunk 가 합쳐진 **최종 바이트**인데, 헤더는 원래 전송 형태(`content-encoding: gzip`,
 * `transfer-encoding: chunked`, 원문 길이)를 가리킨다. 그대로 저장하면 Replay 의
 * `restoreHttpOutcome` 이 평문 body 에 "gzip 이다" 라는 헤더를 붙여 돌려주고, 헤더를 읽는
 * 서버 코드는 녹화 때와 다른 응답을 본다. 저장본이 설명하는 것은 저장된 body 여야 한다.
 */
const TRANSPORT_HEADER_NAMES = new Set(["content-length", "content-encoding", "transfer-encoding"]);

/**
 * `location`·`content-location` 은 RFC 9110 상 상대 참조일 수 있다(`Location: /hooks/SECRET`).
 * 거부하지 않고 **응답 URL 을 기준으로 절대 URL 로 해석한 뒤** 같은 경로 제거 규칙을 적용한다
 * — 거부하면 상대 `Location` 을 쓰는 정상적인 생성 응답이 통째로 실패한다(ADR-0053).
 * 해석에 실패하는 값(형식이 URL 이 아님)은 통째로 가린다 — 무엇을 지워야 할지 모르는
 * 값을 원문으로 남기지 않는다.
 */
const pathRedactedHeaderUrl = (rawValue, baseUrl) => {
  try {
    return pathRedactedUrl(new URL(rawValue, baseUrl).href);
  } catch {
    return REDACTED;
  }
};

/**
 * 응답 헤더를 저장 형태로 바꾼다.
 *
 * 한때 `SENSITIVE_HEADER_NAMES` 4개만 마스킹했다. 그 blocklist 에 없는 `x-api-key` ·
 * `x-auth-token` · `www-authenticate` 는 토큰을 원문 그대로 세션에 남겼다. 요청 쪽은
 * allowlist(`MATCH_HEADER_NAMES`)라 안전했는데 응답 쪽만 반대였다.
 *
 * 그래서 이름 판정에도 `sensitiveKey` 를 태운다. 헤더 이름은 `-` 로 끊긴 단어열이라
 * 민감 키 판정이 그대로 먹는다 — `x-api-key` 의 접미 단어열이 `apikey` 다(ADR-0039).
 * 고정 목록은 `authorization` 처럼 단어 규칙만으로는 안 걸리는 이름을 위해 남긴다.
 */
const storedResponseHeaders = (headers, baseUrl) => {
  const result = [];
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (TRANSPORT_HEADER_NAMES.has(name)) continue;
    if (URL_PATH_HEADER_NAMES.has(name)) {
      result.push([name, pathRedactedHeaderUrl(rawValue, baseUrl)]);
      continue;
    }
    const secret = SENSITIVE_HEADER_NAMES.has(name) || sensitiveKey(name);
    result.push([name, secret ? REDACTED : rawValue]);
  }
  return result;
};

export async function encodeHttpResponse(response) {
  if (response.redirected || REDIRECT_STATUS.has(response.status))
    fail("UNSUPPORTED_HTTP_RESPONSE", "redirect 응답(3xx)은 지원하지 않습니다.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let body;
  try {
    body = bytesAsJson(bytes, response.headers.get("content-type") ?? "", "response");
  } catch (error) {
    if (error?.code === "UNSUPPORTED_HTTP_BODY") error.code = "UNSUPPORTED_HTTP_RESPONSE";
    throw error;
  }
  return {
    kind: "response",
    status: response.status,
    statusText: response.statusText,
    headers: storedResponseHeaders(response.headers, response.url),
    url: pathRedactedUrl(response.url),
    body,
  };
}

/** 저장을 허용하는 오류 code. 여기 없는 값은 자유 텍스트로 보고 버린다. */
const FAILURE_CODES = new Map([
  ["ABORT_ERR", "abort"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ["ETIMEDOUT", "timeout"],
  ["EAI_AGAIN", "dns"],
  ["ENOTFOUND", "dns"],
  ["ECONNREFUSED", "connection"],
  ["ECONNRESET", "connection"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
]);

const FAILURE_NAMES = new Set(["Error", "TypeError", "AbortError"]);

/**
 * `AbortSignal.timeout()` 이 만드는 실패는 `name` 이 `TimeoutError` 이고 `code` 가 **숫자**
 * 23 이다(수동 abort 는 `AbortError` / 20). 숫자 code 는 문자열 검사에 안 걸리고
 * `TimeoutError` 는 아래 이름 목록에 없어서, 손대지 않으면 timeout 이 `unknown` 으로
 * 저장된다 — Replay 때 "실패했습니다" 만 남고 시간 초과였다는 사실이 사라진다.
 *
 * ADR-0053 의 `StoredHttpThrowV1` 은 `name` 을 `Error` · `TypeError` · `AbortError` 셋으로
 * 못 박았고 `TimeoutError` 를 예상하지 못했다. 열거형을 늘리는 것은 저장 형식 변경이라
 * schema version 이 걸린다. 그래서 **의미를 담는 `failureKind` 는 `timeout` 으로 정확히
 * 저장하고, `name` 만 허용 집합 안의 `AbortError` 로 정규화한다** — timeout 도 fetch
 * 수준에서는 abort 이므로 거짓이 아니다. 열거형 확장은 ADR 개정에서 다룬다.
 */
const TIMEOUT_ERROR_NAME = "TimeoutError";

/** 사용자가 보는 문장. **저장본이 아니라 복원 시점에 kind 로부터 만든다.** */
const FAILURE_MESSAGES = {
  abort: "외부 HTTP 호출이 중단되었습니다 (abort).",
  timeout: "외부 HTTP 호출이 제한 시간 안에 끝나지 않았습니다 (timeout).",
  dns: "외부 HTTP 호출의 host 이름을 찾지 못했습니다 (DNS).",
  connection: "외부 HTTP 호출의 연결이 거부되었거나 끊겼습니다 (connection).",
  tls: "외부 HTTP 호출의 TLS 인증서 검증에 실패했습니다 (TLS).",
  network: "외부 HTTP 호출이 네트워크 오류로 실패했습니다.",
  unknown: "외부 HTTP 호출이 실패했습니다.",
};

/**
 * 던져진 오류를 **안전한 envelope** 로 좁힌다(ADR-0053 `StoredHttpThrowV1`).
 *
 * 원본 `message`·`stack`·`cause` 는 담지 않는다. 여기서 버리지 않으면 실패한 URL 과 그
 * query 의 token 이 세션에 그대로 남는다 — 자유 텍스트라 마스킹이 걸리지 않는다.
 *
 * 분류 우선순위는 code 가 먼저다. code 는 런타임이 주는 닫힌 식별자라 문구보다 안정적이다.
 * 목록에 없는 code 는 그 자체가 자유 텍스트일 수 있으므로 저장하지 않고 kind 만 남긴다.
 */
export function encodeHttpThrow(error) {
  if (!(error instanceof Error)) return { kind: "throw", failureKind: "unknown", name: "Error" };

  if (error.name === TIMEOUT_ERROR_NAME)
    return { kind: "throw", failureKind: "timeout", name: "AbortError" };

  const name = FAILURE_NAMES.has(error.name) ? error.name : "Error";
  const code = typeof error.code === "string" ? error.code : undefined;
  const byCode = code === undefined ? undefined : FAILURE_CODES.get(code);
  if (byCode !== undefined) return { kind: "throw", failureKind: byCode, name, code };

  // code 로 못 가르면 name 만 본다. `TypeError` 는 `fetch` 가 네트워크 실패에 쓰는 이름이다.
  if (name === "AbortError") return { kind: "throw", failureKind: "abort", name };
  if (name === "TypeError") return { kind: "throw", failureKind: "network", name };
  return { kind: "throw", failureKind: "unknown", name };
}

export function restoreHttpOutcome(outcome) {
  if (outcome.kind === "throw") {
    // 문장은 저장본이 아니라 failureKind 에서 만든다. 원본 message 를 저장하지 않기 때문이고,
    // 덕분에 같은 kind 는 항상 같은 문장을 낸다(결정론성).
    const error = new Error(FAILURE_MESSAGES[outcome.failureKind] ?? FAILURE_MESSAGES.unknown);
    error.name = outcome.name;
    if (outcome.code !== undefined) error.code = outcome.code;
    throw error;
  }
  const response = new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    statusText: outcome.statusText,
    headers: outcome.headers,
  });
  try {
    Object.defineProperty(response, "url", {
      value: outcome.url,
      configurable: true,
      enumerable: true,
    });
  } catch {
    fail("UNSUPPORTED_HTTP_RESPONSE", "현재 런타임에서 Response.url을 복원할 수 없습니다.");
  }
  if (response.url !== outcome.url)
    fail("UNSUPPORTED_HTTP_RESPONSE", "현재 런타임에서 Response.url을 복원할 수 없습니다.");
  return response;
}

/**
 * 이미 정규화된 `display` 에 **마스킹을 한 번 더 적용**한다.
 *
 * 자식이 제대로 마스킹했다면 이 함수는 아무것도 바꾸지 않는다 — 멱등이다. 그래서 부모는
 * 결과를 원본과 바이트 비교하는 것만으로 "자식이 뭔가 놓쳤다" 를 알 수 있다(ADR-0052 의
 * Store 직전 재검사). `match` 는 재검사 대상이 아니다 — wire 형식에 그 필드를 실을 자리가
 * 없어서, 실려 있으면 이 함수에 닿기 전에 `parent` 쪽 재구성이 이미 세션을 실패로 닫는다.
 *
 * 전체 정규화를 다시 돌리지 않는 이유는 부모에게 원본 `Request` 가 없기 때문이다. 부모가
 * 가진 것은 자식이 보낸 구조뿐이고, 재검사가 보는 것도 "그 구조에 마스킹 규칙이 이미
 * 적용돼 있는가" 하나다.
 */
const redactHttpDisplay = (value) => {
  const headers = {};
  for (const name of Object.keys(value.headers ?? {}).sort()) {
    const lower = name.toLowerCase();
    const secret = !MATCH_HEADER_NAMES.has(lower) || SENSITIVE_HEADER_NAMES.has(lower);
    setOwn(headers, lower, secret ? [REDACTED] : value.headers[name]);
  }
  const body =
    value.body?.kind === "json"
      ? { kind: "json", value: redactJson(value.body.value) }
      : { kind: "none" };
  return {
    method: value.method,
    url: pathRedactedUrl(value.url),
    headers,
    body,
  };
};

export const redactNormalizedRequest = (request) => ({
  protocol: request.protocol,
  interactionSchemaVersion: request.interactionSchemaVersion,
  matchKey: request.matchKey,
  display: redactHttpDisplay(request.display),
});

/**
 * 저장 직전 outcome 에 마스킹을 다시 적용한다. 자식이 제대로 했다면 멱등이다.
 *
 * **두 갈래 다 알려진 필드만 옮겨 담아 새 객체를 만든다.** 재검사의 값어치는 바이트 비교에서
 * 나오는데(`assertRedacted`), 입력을 그대로 돌려주면 그 비교가 **같은 참조끼리 비교하는
 * 항등식**이 되어 무엇도 걸러내지 못한다. 한때 `throw` 갈래가 그랬다 — `{kind:"throw", …,
 * leaked:"https://host/hooks/SECRET"}` 이 검증 없이 통과해 그대로 저장됐다. `response` 는
 * 처음부터 재구성했기 때문에 같은 값을 실어도 낯선 필드가 `rechecked` 에서 사라지고 비교가
 * 어긋나 잡혔다. 구멍은 "재구성이 한쪽에만 있었다" 는 것 하나였다.
 */
export const redactStoredOutcome = (outcome) => {
  if (outcome.kind === "throw")
    return {
      kind: "throw",
      failureKind: outcome.failureKind,
      name: outcome.name,
      // `code` 는 선택 필드다(`StoredHttpThrow`). 없을 때 `undefined` 로 실으면 `stableStringify`
      // 가 `normalizeJson` 에서 그것을 `null` 로 바꿔, 원본에 없던 키가 생겨 비교가 어긋난다.
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
    };
  if (outcome.kind !== "response") return outcome;
  return {
    kind: "response",
    status: outcome.status,
    statusText: outcome.statusText,
    headers: (outcome.headers ?? []).map(([name, value]) => {
      const lower = String(name).toLowerCase();
      if (URL_PATH_HEADER_NAMES.has(lower))
        return [lower, pathRedactedHeaderUrl(value, outcome.url)];
      const secret = SENSITIVE_HEADER_NAMES.has(lower) || sensitiveKey(lower);
      return [lower, secret ? REDACTED : value];
    }),
    url: pathRedactedUrl(outcome.url),
    body: redactJson(outcome.body),
  };
};
