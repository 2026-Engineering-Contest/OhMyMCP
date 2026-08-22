import { afterEach, describe, expect, it } from "vitest";
import { startExternalCoordinator } from "../../src/external/coordinator.js";
import { MAX_COORDINATOR_PAYLOAD_BYTES } from "../../src/external/protocol.js";
import { createMemorySessionStore } from "../../src/external/session-store.js";

const handles: Array<Awaited<ReturnType<typeof startExternalCoordinator>>> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.finish("failed")));
});

describe("external coordinator authentication", () => {
  it("token 누락은 401, 틀린 token은 403이며 오류 본문에 token을 싣지 않는다", async () => {
    const handle = await startExternalCoordinator({
      mode: "record",
      sessionId: "auth",
      store: createMemorySessionStore(),
    });
    handles.push(handle);
    const token = handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN ?? "";

    const missing = await fetch(`${handle.url}/begin`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(await missing.text()).not.toContain(token);

    const wrongToken = "wrong-token-value";
    const wrong = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: { authorization: `Bearer ${wrongToken}` },
      body: "{}",
    });
    expect(wrong.status).toBe(403);
    const body = await wrong.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(wrongToken);
  });

  it("알 수 없는 schema version과 payload 상한 초과를 fail-closed로 거절한다", async () => {
    const handle = await startExternalCoordinator({
      mode: "record",
      sessionId: "limits",
      store: createMemorySessionStore(),
    });
    handles.push(handle);
    const token = handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN ?? "";
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const unknown = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers,
      body: JSON.stringify({ schemaVersion: 999 }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "SCHEMA_VERSION_UNSUPPORTED" } });

    const oversized = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers,
      body: "x".repeat(MAX_COORDINATOR_PAYLOAD_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });
});

describe("Store 직전 재검사 (ADR-0052)", () => {
  /**
   * 규칙을 지킨 자식이 보낼 법한 값. 민감 값은 이미 마스킹돼 있고, `display.url` 의 pathname
   * 도 이미 `<redacted>` 다 — 재검사(`redactNormalizedRequest`)가 다시 지워도 바이트가
   * 같아야 멱등이다(ADR-0053). `match` 필드는 없다 — wire 형식에 실을 자리가 없다.
   */
  const redacted = {
    protocol: "http",
    interactionSchemaVersion: 1,
    matchKey: "a".repeat(64),
    display: {
      method: "GET",
      url: "https://example.com/<redacted>?apiKey=%5Bredacted%5D",
      headers: { accept: ["application/json"], authorization: ["[redacted]"] },
      body: { kind: "none" },
    },
  };

  const begin = async (
    handle: Awaited<ReturnType<typeof startExternalCoordinator>>,
    request: unknown,
  ) =>
    fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schemaVersion: 1, request }),
    });

  const start = async () => {
    const handle = await startExternalCoordinator({
      mode: "record",
      sessionId: "recheck",
      store: createMemorySessionStore(),
    });
    handles.push(handle);
    return handle;
  };

  it("제대로 마스킹된 요청은 그대로 통과한다 — 재적용이 멱등이다", async () => {
    const handle = await start();

    expect((await begin(handle, redacted)).status).toBe(200);
  });

  it("자식이 URL query의 토큰을 놓치면 저장 전에 실패한다", async () => {
    const handle = await start();
    const leaky = {
      ...redacted,
      display: { ...redacted.display, url: "https://example.com/<redacted>?apiKey=super-secret" },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    // 오류 본문에 새어 나온 값을 다시 실으면 안 된다.
    expect(body).not.toContain("super-secret");
  });

  it("match 필드(matching 재료)가 실리면 형태가 맞아도 저장 전에 실패한다", async () => {
    const handle = await start();
    // wire 형식에는 match 를 실을 자리가 없다(ADR-0053). 자식이 그래도 보내면 재구성이
    // 거부한다 — pathname 이 든 값이므로 형태 검사만으로는 못 잡는다.
    const leaky = {
      ...redacted,
      match: {
        method: "GET",
        url: "https://example.com/hooks/SECRET",
        headers: {},
        body: { kind: "none" },
      },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).not.toContain("SECRET");
    // 위반 진단에는 고정된 분류만 싣는다 — 필드 이름도 값도 싣지 않는다.
    expect(body).toContain("match-field");
  });

  it("알려지지 않은 필드가 실리면 형태가 맞아도 저장 전에 실패한다", async () => {
    const handle = await start();
    const leaky = { ...redacted, extra: "https://example.com/hooks/SECRET" };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("extra");
    expect(body).toContain("unknown-field");
  });

  it("display 안에 중첩된 낯선 필드도 같은 분류로 거부한다 — 바깥만 보면 진단이 뒤바뀐다", async () => {
    const handle = await start();
    // 바깥 키는 전부 알려진 것이라 최상위 검사만으로는 통과한다. 중첩까지 보지 않으면
    // redactHttpDisplay 가 이 필드를 조용히 버리고, 바이트 비교만 어긋나 "부모의 재검사가
    // 추가 마스킹을 적용했습니다" 라는 엉뚱한 진단이 나간다 — 원인은 스키마에 없는 필드인데
    // 사용자는 민감 키 목록 version 을 의심하게 된다.
    const leaky = {
      ...redacted,
      display: { ...redacted.display, extraLeakyField: "https://example.com/hooks/SECRET" },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).toContain("unknown-field");
    expect(body).not.toContain("추가 마스킹");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("extraLeakyField");
  });

  /**
   * 두 결함의 회귀 스펙이다.
   *
   * 하나는 오류의 정체다. `runtime.mjs` 는 자식에서도 돌아 `.ts` 를 import 할 수 없어 오류를
   * `new Error()` 에 `name`·`code` 만 얹어 흉내 냈는데, 그 값은 `ExternalRecordReplayError` 의
   * 인스턴스가 아니라서 부모의 `instanceof` 분기를 빠져나갔다 — 500 이 나갔다.
   *
   * 다른 하나는 세션이다. 500 을 400 으로 고쳐도 code 가 `UNSUPPORTED_HTTP_URL` 이면 세션을
   * 닫는 분기를 여전히 비껴가 `running` 으로 남았다. 재검사가 던지는 것도 자식의 계약 위반이라
   * 그 자리에서 분류를 바꾼다. **닫힌다고 이름 붙였으면 닫히는 것을 봐야 한다.**
   */
  it("재검사가 해석하지 못한 값은 분류된 4xx 로 나가고 세션을 실패로 닫는다", async () => {
    const store = createMemorySessionStore();
    const handle = await startExternalCoordinator({ mode: "record", sessionId: "urlfail", store });
    handles.push(handle);
    // 자격증명이 든 URL 은 `parseNormalizedUrl` 이 거부한다. 그 거부가 재검사(redact) 경로
    // 안에서 일어나는 것이 요점이다 — 형태 검사는 이미 통과한 뒤다.
    const leaky = {
      ...redacted,
      display: { ...redacted.display, url: "https://user:pass@example.com/x" },
    };

    const response = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schemaVersion: 1, request: leaky }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).toContain("unnormalizable-value");
    expect(body).not.toContain("COORDINATOR_INTERNAL");
    // 오류 본문에 자격증명을 다시 실으면 안 된다.
    expect(body).not.toContain("pass");
    // 이름이 주장하는 쪽. 세션이 running 으로 남으면 자식이 값을 고쳐 다시 보내 통과할 수 있다.
    expect(store.read("urlfail")?.status).toBe("failed");
  });

  it("알려진 필드라도 값의 형태가 다르면 거부한다 — method 는 그대로 복사되는 자리다", async () => {
    const store = createMemorySessionStore();
    const handle = await startExternalCoordinator({ mode: "record", sessionId: "badvalue", store });
    handles.push(handle);
    // `redactHttpDisplay` 는 method 를 그대로 복사하므로 값이 무엇이든 바이트 비교가 통과한다.
    // 필드 이름만 막고 값을 안 보면 지우려던 경로가 이 자리로 저장된다(실측으로 확인했다).
    const leaky = {
      ...redacted,
      display: { ...redacted.display, method: { leak: "https://example.com/hooks/SECRET" } },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).toContain("invalid-value");
    expect(body).not.toContain("SECRET");
    // 저장본에 닿지 않았는지가 이 스펙의 본론이다.
    expect(JSON.stringify(store.read("badvalue"))).not.toContain("SECRET");
  });

  it("헤더 이름이 RFC 7230 token 이 아니면 거부한다 — 이름 자리로도 경로가 들어온다", async () => {
    const handle = await start();
    const leaky = {
      ...redacted,
      display: {
        ...redacted.display,
        headers: { "https://example.com/hooks/SECRET": ["x"] },
      },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("invalid-value");
    expect(body).not.toContain("SECRET");
  });

  it("자식이 헤더의 자격증명을 놓치면 저장 전에 실패한다", async () => {
    const handle = await start();
    const leaky = {
      ...redacted,
      display: {
        ...redacted.display,
        headers: { ...redacted.display.headers, authorization: ["Bearer super-secret"] },
      },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).not.toContain("super-secret");
  });

  it("자식이 body의 민감 필드를 놓치면 저장 전에 실패한다", async () => {
    const handle = await start();
    const leaky = {
      ...redacted,
      display: {
        ...redacted.display,
        body: { kind: "json", value: { nested: { accessToken: "super-secret" } } },
      },
    };

    const response = await begin(handle, leaky);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(body).not.toContain("super-secret");
  });
});

describe("불변식 위반 뒤 세션 상태 (ADR-0052)", () => {
  const clean = {
    protocol: "http",
    interactionSchemaVersion: 1,
    matchKey: "b".repeat(64),
    display: {
      method: "GET",
      url: "https://example.com/<redacted>",
      headers: { accept: ["application/json"] },
      body: { kind: "none" },
    },
  };

  it("누출된 outcome을 보낸 뒤에는 제대로 마스킹해 다시 보내도 통과하지 못한다", async () => {
    const store = createMemorySessionStore();
    const handle = await startExternalCoordinator({ mode: "record", sessionId: "leak", store });
    handles.push(handle);
    const auth = {
      authorization: `Bearer ${handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN}`,
      "content-type": "application/json",
    };

    const began = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ schemaVersion: 1, request: clean }),
    });
    expect(began.status).toBe(200);
    const { reservation } = (await began.json()) as { reservation: { interactionId: string } };

    // 자식이 응답 헤더의 토큰을 놓친 채 보낸다.
    const leaky = await fetch(`${handle.url}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        schemaVersion: 1,
        interactionId: reservation.interactionId,
        outcome: {
          kind: "response",
          status: 200,
          statusText: "OK",
          headers: [["x-api-key", "super-secret"]],
          url: "https://example.com/<redacted>",
          body: { ok: true },
        },
      }),
    });
    expect(leaky.status).toBe(400);
    expect(await leaky.text()).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");

    // 세션이 이미 닫혔으므로 깨끗한 재시도도 받지 않는다. 400 만 주고 running 으로 두면
    // 여기서 통과해 "새는 Adapter 가 만든 깨끗해 보이는 녹화" 가 남는다.
    const retry = await fetch(`${handle.url}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        schemaVersion: 1,
        interactionId: reservation.interactionId,
        outcome: {
          kind: "response",
          status: 200,
          statusText: "OK",
          headers: [["x-api-key", "[redacted]"]],
          url: "https://example.com/<redacted>",
          body: { ok: true },
        },
      }),
    });

    expect(retry.status).not.toBe(200);
    expect(store.read("leak")?.status).toBe("failed");
    expect(store.read("leak")?.interactions[0]?.status).toBe("incomplete");
  });

  /**
   * `throw` 갈래의 회귀 스펙이다.
   *
   * `redactStoredOutcome` 이 response 가 아닌 값을 **입력 그대로** 돌려주던 때, 재검사의 바이트
   * 비교가 같은 참조끼리 비교하는 항등식이 되어 아무것도 걸러내지 못했다. 그래서 자식이 실어
   * 보낸 낯선 필드가 검증 없이 그대로 저장됐다 — 지우려던 경로를 담아도 통과했다.
   *
   * response 갈래는 처음부터 알려진 필드로 재구성했기 때문에 같은 값을 실어도 걸렸다. 구멍은
   * "재구성이 한쪽에만 있었다" 는 것 하나였고, 그래서 고친 것도 재구성을 양쪽에 두는 것이다.
   */
  it("throw outcome 에 실린 낯선 필드도 거부한다 — 재구성이 없으면 재검사가 항등식이 된다", async () => {
    const store = createMemorySessionStore();
    const handle = await startExternalCoordinator({ mode: "record", sessionId: "throwleak", store });
    handles.push(handle);
    const auth = {
      authorization: `Bearer ${handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN}`,
      "content-type": "application/json",
    };

    const began = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ schemaVersion: 1, request: clean }),
    });
    expect(began.status).toBe(200);
    const { reservation } = (await began.json()) as { reservation: { interactionId: string } };

    const leaky = await fetch(`${handle.url}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        schemaVersion: 1,
        interactionId: reservation.interactionId,
        outcome: {
          kind: "throw",
          failureKind: "network",
          name: "TypeError",
          // 스키마에 없는 필드. 경로가 든 URL 을 실어 보낸다.
          leaked: "https://hooks.slack.com/services/T00/B00/XXXXSECRET",
        },
      }),
    });

    expect(leaky.status).toBe(400);
    expect(await leaky.text()).toContain("EXTERNAL_REDACTION_INVARIANT_VIOLATION");
    expect(store.read("throwleak")?.status).toBe("failed");
    // 저장까지 갔는지가 이 스펙의 요점이다. 상호작용이 완료로 남으면 그 안에 경로가 있다.
    expect(store.read("throwleak")?.interactions[0]?.status).toBe("incomplete");
  });

  /** 정상적인 `throw` 는 그대로 통과해야 한다. 재구성이 멀쩡한 값을 바꾸면 전부 실패한다. */
  it("알려진 필드만 담은 throw outcome 은 통과한다", async () => {
    const store = createMemorySessionStore();
    const handle = await startExternalCoordinator({ mode: "record", sessionId: "throwok", store });
    handles.push(handle);
    const auth = {
      authorization: `Bearer ${handle.childEnvironment.MCPEAK_EXTERNAL_COORDINATOR_TOKEN}`,
      "content-type": "application/json",
    };

    const began = await fetch(`${handle.url}/begin`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ schemaVersion: 1, request: clean }),
    });
    const { reservation } = (await began.json()) as { reservation: { interactionId: string } };

    // `code` 는 선택 필드다. 없는 경우가 재구성에서 `null` 로 새로 생기면 비교가 어긋난다.
    const done = await fetch(`${handle.url}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        schemaVersion: 1,
        interactionId: reservation.interactionId,
        outcome: { kind: "throw", failureKind: "network", name: "TypeError" },
      }),
    });

    expect(done.status).toBe(200);
    expect(store.read("throwok")?.interactions[0]?.status).toBe("complete");
  });
});
