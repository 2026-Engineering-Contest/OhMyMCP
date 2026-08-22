import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_COORDINATOR_PAYLOAD_BYTES, MAX_HTTP_BODY_BYTES } from "../../src/external/protocol.js";
import {
  encodeHttpResponse,
  encodeHttpThrow,
  HTTP_INTERACTION_SCHEMA_VERSION,
  HTTP_MATCH_KEY_DOMAIN,
  type HttpMatchMaterialV1,
  httpMatchKey,
  normalizeHttpRequest,
  restoreHttpOutcome,
  stableStringify,
} from "../../src/external/runtime.mjs";

describe("normalizeHttpRequest", () => {
  it("JSON 객체 키 순서가 달라도 같은 matchKey를 만든다", async () => {
    const left = await normalizeHttpRequest(
      new Request("https://EXAMPLE.com:443/weather?city=seoul", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ city: "seoul", unit: "c" }),
      }),
    );
    const right = await normalizeHttpRequest(
      new Request("https://example.com/weather?city=seoul", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit: "c", city: "seoul" }),
      }),
    );

    expect(left.matchKey).toBe(right.matchKey);
    // 경로가 다른 두 요청이 우연히 여기서 나오면 pathname 이 matchKey 에 안 들어간 것이다.
    expect(left.display.url).toBe("https://example.com/<redacted>?city=seoul");
  });

  it("display.url 에 pathname 문자열이 없다 — Coordinator·Store 로 나가는 유일한 자리다(ADR-0053)", async () => {
    const normalized = await normalizeHttpRequest(
      new Request("https://example.com/hooks/T000/B111/XXXXsecret?page=2"),
    );

    expect(normalized.display.url).toBe("https://example.com/<redacted>?page=2");
    expect(JSON.stringify(normalized)).not.toContain("/hooks/T000/B111/XXXXsecret");
    // wire 로 나가는 값에는 애초에 match 필드가 없다 — 실을 자리 자체가 없다(WireHttpRequestV1).
    expect(normalized).not.toHaveProperty("match");
  });

  it("stable JSON은 undefined와 -0을 고정하고 sparse array를 거절한다", () => {
    expect(stableStringify({ b: undefined, a: -0, values: [undefined] })).toBe(
      '{"a":0,"values":[null]}',
    );
    const sparse = [1, 2];
    delete sparse[0];
    expect(() => stableStringify(sparse)).toThrowError(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
  });

  it("query 순서는 보존해서 다른 순서를 false hit로 합치지 않는다", async () => {
    const left = await normalizeHttpRequest(new Request("https://example.com/search?a=1&b=2"));
    const right = await normalizeHttpRequest(new Request("https://example.com/search?b=2&a=1"));

    expect(left.matchKey).not.toBe(right.matchKey);
  });

  it("민감 query와 JSON 값은 matchKey 계산 전에 마스킹한다", async () => {
    const make = (token: string) =>
      normalizeHttpRequest(
        new Request(`https://example.com/data?access_token=${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nested: { apiKey: token }, visible: "same" }),
        }),
      );

    const left = await make("secret-left");
    const right = await make("secret-right");

    expect(left.matchKey).toBe(right.matchKey);
    expect(JSON.stringify(left)).not.toContain("secret-left");
    expect(left.display.url).toContain("%5Bredacted%5D");
    expect(left.display.body).toEqual({
      kind: "json",
      value: { nested: { apiKey: "[redacted]" }, visible: "same" },
    });
  });

  it("allowlist 밖 헤더는 매칭에서 제외하고 allowlist 헤더는 포함한다", async () => {
    const base = "https://example.com/data";
    const first = await normalizeHttpRequest(
      new Request(base, { headers: { accept: "application/json", "user-agent": "first" } }),
    );
    const ignored = await normalizeHttpRequest(
      new Request(base, { headers: { accept: "application/json", "user-agent": "second" } }),
    );
    const meaningful = await normalizeHttpRequest(
      new Request(base, { headers: { accept: "application/problem+json" } }),
    );

    expect(first.matchKey).toBe(ignored.matchKey);
    expect(first.matchKey).not.toBe(meaningful.matchKey);
  });

  it("JSON이 아닌 request body와 1 MiB 초과 body를 실제 호출 전에 거절한다", async () => {
    await expect(
      normalizeHttpRequest(
        new Request("https://example.com/data", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "plain text",
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HTTP_BODY" });

    const oversized = JSON.stringify({ value: "x".repeat(1024 * 1024) });
    await expect(
      normalizeHttpRequest(
        new Request("https://example.com/data", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversized,
        }),
      ),
    ).rejects.toMatchObject({ code: "HTTP_BODY_TOO_LARGE" });
  });

  it("Replay Response의 url과 표준 관찰값을 함께 복원한다", async () => {
    const restored = restoreHttpOutcome({
      kind: "response",
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"]],
      url: "https://example.com/final",
      body: { ok: true },
    });

    expect(restored).toBeInstanceOf(Response);
    expect(restored.status).toBe(201);
    expect(restored.ok).toBe(true);
    expect(restored.url).toBe("https://example.com/final");
    expect(await restored.json()).toEqual({ ok: true });
  });

  it("저장할 response의 URL, 헤더, JSON body에서 민감 값을 제거한다", async () => {
    const response = new Response(JSON.stringify({ nested: { accessToken: "body-secret" } }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=header-secret",
      },
    });
    Object.defineProperty(response, "url", {
      value: "https://example.com/final?apiKey=url-secret",
      configurable: true,
    });

    const stored = await encodeHttpResponse(response);

    expect(stored.url).toBe("https://example.com/<redacted>?apiKey=%5Bredacted%5D");
    expect(stored.body).toEqual({ nested: { accessToken: "[redacted]" } });
    expect(stored.headers).toContainEqual(["set-cookie", "[redacted]"]);
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect(JSON.stringify(stored)).not.toContain("final");
  });

  it("301·302·303·307·308 은 redirected 값과 무관하게 거부한다 — 다섯 개만이다(ADR-0053)", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const response = new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { "content-type": "application/json", location: "/hooks/SECRET" },
      });
      Object.defineProperty(response, "url", {
        value: "https://example.com/x",
        configurable: true,
      });
      Object.defineProperty(response, "redirected", { value: false, configurable: true });

      await expect(encodeHttpResponse(response)).rejects.toMatchObject({
        code: "UNSUPPORTED_HTTP_RESPONSE",
      });
    }

    // 대조군 — 3xx 라고 전부 거부하지 않는다. 300 과 304 는 리다이렉트가 아니다.
    const notModified = new Response(null, { status: 304 });
    Object.defineProperty(notModified, "url", {
      value: "https://example.com/x",
      configurable: true,
    });
    // 304 는 본문이 없어 JSON body 규칙에 따로 걸린다 — 이 범위는 다루지 않는다.
    await expect(encodeHttpResponse(notModified)).rejects.toMatchObject({
      code: "UNSUPPORTED_HTTP_RESPONSE",
    });
  });

  it("location·content-location 은 상대 참조여도 거부하지 않고 경로만 지운다", async () => {
    const response = new Response(JSON.stringify({ created: true }), {
      status: 201,
      headers: {
        "content-type": "application/json",
        location: "/hooks/T000/B111/SECRET?token=abc",
        "content-location": "https://other.example.com/hooks/ANOTHER?x=1",
      },
    });
    Object.defineProperty(response, "url", {
      value: "https://example.com/create",
      configurable: true,
    });

    const stored = await encodeHttpResponse(response);
    const location = stored.headers.find(([name]) => name === "location");
    const contentLocation = stored.headers.find(([name]) => name === "content-location");

    // 상대 참조는 응답 URL 을 기준으로 절대 URL 로 해석한 뒤 같은 경로 제거 규칙을 받는다.
    expect(location?.[1]).toBe("https://example.com/<redacted>?token=%5Bredacted%5D");
    expect(contentLocation?.[1]).toBe("https://other.example.com/<redacted>?x=1");
    expect(JSON.stringify(stored)).not.toContain("SECRET");
    expect(JSON.stringify(stored)).not.toContain("ANOTHER");
  });

  it("location 값이 URL 로 해석되지 않으면 통째로 가린다", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      // 절대 참조도 상대 참조도 아니다 — new URL(value, base) 자체가 던지는 값이어야 한다.
      headers: { "content-type": "application/json", location: "http://" },
    });
    Object.defineProperty(response, "url", {
      value: "https://example.com/create",
      configurable: true,
    });

    const stored = await encodeHttpResponse(response);

    expect(stored.headers).toContainEqual(["location", "[redacted]"]);
  });
});

describe("matchKey envelope", () => {
  /**
   * `normalizeHttpRequest` 가 내부에서만 쓰는 매칭 재료를 손으로 다시 만든다. 이 값은
   * 반환값(`NormalizedExternalRequest`)에 실리지 않으므로, 손으로 만든 것이 정확히 같은
   * 요청을 넣었을 때 내부에서 계산했을 값과 같음을 이 describe 블록의 첫 케이스가 보증한다.
   */
  const weatherMatch: HttpMatchMaterialV1 = {
    method: "GET",
    url: "https://example.com/weather?city=seoul",
    headers: {},
    body: { kind: "none" },
  };

  it("domain과 schemaVersion을 해시 입력에 넣는다 — match만 해싱하지 않는다", async () => {
    const request = new Request("https://example.com/weather?city=seoul");
    const normalized = await normalizeHttpRequest(request);

    const withEnvelope = createHash("sha256")
      .update(
        stableStringify({
          domain: HTTP_MATCH_KEY_DOMAIN,
          schemaVersion: HTTP_INTERACTION_SCHEMA_VERSION,
          match: weatherMatch,
        }),
        "utf8",
      )
      .digest("hex");
    const bareMatch = createHash("sha256")
      .update(stableStringify(weatherMatch), "utf8")
      .digest("hex");

    expect(normalized.matchKey).toBe(withEnvelope);
    expect(normalized.matchKey).toBe(httpMatchKey(weatherMatch));
    // envelope 없이 해싱하던 시절의 값과는 반드시 달라야 한다. 같아지면 schema version 이
    // 올라가도 키 공간이 갈라지지 않아 version 1 세션에 version 2 요청이 hit 한다.
    expect(normalized.matchKey).not.toBe(bareMatch);
  });

  it("schemaVersion이 다르면 같은 요청이라도 다른 키가 된다", () => {
    const match: HttpMatchMaterialV1 = {
      method: "GET",
      url: "https://example.com/weather",
      headers: {},
      body: { kind: "none" },
    };
    const keyOf = (schemaVersion: number) =>
      createHash("sha256")
        .update(stableStringify({ domain: HTTP_MATCH_KEY_DOMAIN, schemaVersion, match }), "utf8")
        .digest("hex");

    expect(keyOf(1)).toBe(httpMatchKey(match));
    expect(keyOf(2)).not.toBe(httpMatchKey(match));
  });

  it("domain이 다르면 다른 키가 된다 — legacy 카세트와 해시 공간을 나눈다", () => {
    const match: HttpMatchMaterialV1 = {
      method: "GET",
      url: "https://example.com/weather",
      headers: {},
      body: { kind: "none" },
    };
    const legacyish = createHash("sha256")
      .update(
        stableStringify({
          domain: "mcpeak.legacy.tool",
          schemaVersion: HTTP_INTERACTION_SCHEMA_VERSION,
          match,
        }),
        "utf8",
      )
      .digest("hex");

    expect(httpMatchKey(match)).not.toBe(legacyish);
  });
});

describe("encodeHttpThrow", () => {
  it("원본 message를 저장하지 않는다 — 자유 텍스트에는 마스킹이 걸리지 않는다", () => {
    const error = new Error(
      "request to https://api.example.com/v1?api_key=super-secret failed, reason: connect ECONNREFUSED",
    );
    error.stack = "Error: ... https://api.example.com/v1?api_key=super-secret";

    const stored = encodeHttpThrow(error);

    expect(stored).not.toHaveProperty("message");
    expect(stored).not.toHaveProperty("stack");
    expect(stored).not.toHaveProperty("cause");
    expect(JSON.stringify(stored)).not.toContain("super-secret");
    expect(JSON.stringify(stored)).not.toContain("api.example.com");
  });

  it("허용된 code는 failureKind로 분류해 저장한다", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["ECONNREFUSED", "connection"],
      ["ENOTFOUND", "dns"],
      ["ETIMEDOUT", "timeout"],
      ["CERT_HAS_EXPIRED", "tls"],
      ["ABORT_ERR", "abort"],
    ];
    for (const [code, failureKind] of cases) {
      const error = Object.assign(new Error("아무 문구나"), { code });
      expect(encodeHttpThrow(error)).toEqual({ kind: "throw", failureKind, name: "Error", code });
    }
  });

  it("목록에 없는 code는 저장하지 않는다 — code 자체가 자유 텍스트일 수 있다", () => {
    const error = Object.assign(new Error("boom"), { code: "E_SECRET_abc123" });

    const stored = encodeHttpThrow(error);

    expect(stored).not.toHaveProperty("code");
    expect(JSON.stringify(stored)).not.toContain("abc123");
  });

  it("code가 없으면 name으로 가른다", () => {
    const abort = Object.assign(new Error("x"), { name: "AbortError" });
    expect(encodeHttpThrow(abort)).toEqual({
      kind: "throw",
      failureKind: "abort",
      name: "AbortError",
    });
    expect(encodeHttpThrow(new TypeError("fetch failed"))).toEqual({
      kind: "throw",
      failureKind: "network",
      name: "TypeError",
    });
  });

  it("Error가 아닌 값도 안전한 envelope가 된다", () => {
    expect(encodeHttpThrow("문자열이 던져졌다")).toEqual({
      kind: "throw",
      failureKind: "unknown",
      name: "Error",
    });
  });

  it("복원 문장은 저장본이 아니라 failureKind에서 만든다", () => {
    const stored = encodeHttpThrow(
      Object.assign(new Error("원본 문구는 사라진다"), { code: "ENOTFOUND" }),
    );

    expect(() => restoreHttpOutcome(stored)).toThrow(/host 이름을 찾지 못했습니다/);
    expect(() => restoreHttpOutcome(stored)).not.toThrow(/원본 문구/);
  });
});

describe("응답 헤더 마스킹", () => {
  it("blocklist 밖의 토큰 헤더도 지운다 — 요청 쪽 기준과 맞춘다", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "x-api-key": "leaked-api-key",
        "x-auth-token": "leaked-auth-token",
        "www-authenticate": 'Bearer realm="leaked-realm"',
      },
    });
    Object.defineProperty(response, "url", { value: "https://example.com/x", configurable: true });

    const stored = await encodeHttpResponse(response);

    expect(JSON.stringify(stored)).not.toContain("leaked");
    expect(stored.headers).toContainEqual(["x-api-key", "[redacted]"]);
    expect(stored.headers).toContainEqual(["x-auth-token", "[redacted]"]);
    expect(stored.headers).toContainEqual(["www-authenticate", "[redacted]"]);
    // 민감하지 않은 헤더는 그대로 남는다. 전부 지우면 진단이 사라진다.
    expect(stored.headers).toContainEqual(["content-type", "application/json"]);
  });

  it("전송 표현 헤더는 저장하지 않는다 — 저장된 body 는 이미 풀린 최종 바이트다", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "content-length": "9999",
        etag: '"keep-me"',
      },
    });
    Object.defineProperty(response, "url", { value: "https://example.com/x", configurable: true });

    const stored = await encodeHttpResponse(response);
    const names = stored.headers.map(([name]) => name);

    expect(names).not.toContain("content-encoding");
    expect(names).not.toContain("transfer-encoding");
    expect(names).not.toContain("content-length");
    // 복원한 Response 가 평문 body 에 gzip 이라는 헤더를 달고 나가지 않는다.
    const restored = restoreHttpOutcome(stored);
    expect(restored.headers.get("content-encoding")).toBeNull();
    expect(await restored.json()).toEqual({ ok: true });
    // 전송과 무관한 헤더는 남는다.
    expect(stored.headers).toContainEqual(["etag", '"keep-me"']);
  });
});

describe("Coordinator payload 상한", () => {
  it("HTTP 상한을 통과한 body는 Coordinator 상한도 통과한다", async () => {
    // begin payload 는 body 를 display 에 한 번만 싣는다(match 는 wire 로 나가지 않는다).
    // 두 상한이 따로 정해져 있으면 "지원한다고 한 크기인데 안 되는" 구간이 생긴다.
    const raw = JSON.stringify({ value: "x".repeat(MAX_HTTP_BODY_BYTES - 64) });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(MAX_HTTP_BODY_BYTES);

    const normalized = await normalizeHttpRequest(
      new Request("https://example.com/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    const payload = JSON.stringify({ schemaVersion: 1, request: normalized });

    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(
      MAX_COORDINATOR_PAYLOAD_BYTES,
    );
  });
});

describe("timeout 분류", () => {
  it("AbortSignal.timeout의 TimeoutError를 timeout으로 저장한다", () => {
    // 실측: AbortSignal.timeout() → name "TimeoutError", code 23(숫자).
    // 숫자 code 는 문자열 검사에 안 걸리고 TimeoutError 는 허용 이름에 없어서,
    // 처리하지 않으면 unknown 으로 떨어져 "시간 초과" 라는 사실이 사라진다.
    const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
      code: 23,
    });

    const stored = encodeHttpThrow(timeoutError);

    expect(stored.failureKind).toBe("timeout");
    // ADR-0053 의 name 열거형에 TimeoutError 가 없어 AbortError 로 정규화한다.
    expect(stored.name).toBe("AbortError");
    expect(stored).not.toHaveProperty("code");
    expect(() => restoreHttpOutcome(stored)).toThrow(/제한 시간 안에 끝나지 않았습니다/);
  });

  it("수동 abort는 여전히 abort로 남는다 — 둘을 뭉개지 않는다", () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError", code: 20 });

    expect(encodeHttpThrow(aborted)).toEqual({
      kind: "throw",
      failureKind: "abort",
      name: "AbortError",
    });
  });
});
