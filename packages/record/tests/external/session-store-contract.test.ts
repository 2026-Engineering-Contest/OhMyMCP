import { describe, expect, it } from "vitest";
import type {
  NormalizedExternalRequest,
  StoredExternalOutcome,
} from "../../src/external/protocol.js";
import { createMemorySessionStore, type SessionStore } from "../../src/external/session-store.js";
import { createSqliteSessionStore } from "../../src/external/session-store-sqlite.js";

/**
 * `SessionStore` 구현이 반드시 지켜야 하는 스펙이다. 저장 매체가 아니라 **계약**을 검사한다.
 *
 * SQLite 구현(ADR-0052 의 영속 Store)이 생기면 아래 `STORES` 에 한 줄만 추가한다. 그 구현이
 * 이 파일을 통과하면 Engine·Coordinator·자식 어댑터를 건드리지 않고 갈아 끼울 수 있다는 뜻이다.
 * 통과하지 못하면 그것이 곧 회귀다 — 메모리 구현의 동작을 읽어서 추측하지 않아도 된다.
 *
 * `recordedAt` 은 벽시계라 실행마다 값이 다르다. 여기서는 **존재와 형식만** 보고 값은 보지
 * 않는다. 결정론성(CLAUDE.md)이 걸린 것은 matchKey 이며 그쪽은 `http-match.test.ts` 가 본다.
 */
const STORES: readonly { readonly name: string; readonly create: () => SessionStore }[] = [
  { name: "memory", create: createMemorySessionStore },
  { name: "sqlite", create: () => createSqliteSessionStore() },
];

const request = (matchKey = "match-a"): NormalizedExternalRequest => ({
  protocol: "http",
  interactionSchemaVersion: 1,
  matchKey,
  display: {
    method: "GET",
    url: `https://example.com/${matchKey}`,
    headers: {},
    body: { kind: "none" },
  },
});

const outcome = (status = 200): StoredExternalOutcome => ({
  kind: "response",
  status,
  statusText: "OK",
  headers: [["content-type", "application/json"]],
  url: "https://example.com/match-a",
  body: { ok: true },
});

/** 예약하고 바로 완료해 `complete` 상태의 interaction 하나를 만든다. */
const recordOne = (store: SessionStore, sessionId: string, matchKey: string): string => {
  const reservation = store.reserve({ sessionId, request: request(matchKey) });
  store.complete({ sessionId, interactionId: reservation.interactionId, outcome: outcome() });
  return reservation.interactionId;
};

/** 던져진 오류의 `code` 를 꺼낸다. 메시지 문구가 아니라 코드로 판정하기 위한 것이다. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "(code 없음)";
  }
  throw new Error("오류가 발생하지 않았습니다.");
};

describe.each(STORES)("SessionStore 계약 — $name", ({ create }) => {
  describe("createSession", () => {
    it("빈 sessionId를 거절한다", () => {
      expect(codeOf(() => create().createSession(""))).toBe("REQUEST_INVALID");
    });

    it("같은 sessionId를 두 번 만들지 않는다 — 기존 세션을 덮어쓰면 녹화본이 소리 없이 사라진다", () => {
      const store = create();
      store.createSession("s1");
      expect(codeOf(() => store.createSession("s1"))).toBe("SESSION_ALREADY_EXISTS");
    });
  });

  describe("reserve", () => {
    it("없는 세션에 예약하지 않는다", () => {
      const store = create();
      expect(codeOf(() => store.reserve({ sessionId: "없음", request: request() }))).toBe(
        "SESSION_NOT_FOUND",
      );
    });

    it("ordinal은 세션 전체 순번, occurrence는 matchKey별 0부터 센다", () => {
      const store = create();
      store.createSession("s1");

      const first = store.reserve({ sessionId: "s1", request: request("a") });
      store.complete({ sessionId: "s1", interactionId: first.interactionId, outcome: outcome() });
      const second = store.reserve({ sessionId: "s1", request: request("b") });
      store.complete({ sessionId: "s1", interactionId: second.interactionId, outcome: outcome() });
      const third = store.reserve({ sessionId: "s1", request: request("a") });

      expect([first.ordinal, second.ordinal, third.ordinal]).toEqual([0, 1, 2]);
      expect([first.occurrence, second.occurrence, third.occurrence]).toEqual([0, 0, 1]);
    });

    it("interactionId는 세션 안에서 유일하다", () => {
      const store = create();
      store.createSession("s1");
      const ids = new Set<string>();
      for (let index = 0; index < 3; index += 1) {
        ids.add(recordOne(store, "s1", `key-${index}`));
      }
      expect(ids.size).toBe(3);
    });

    it("recordedAt은 ISO-8601 문자열이다", () => {
      const store = create();
      store.createSession("s1");
      const reservation = store.reserve({ sessionId: "s1", request: request() });
      expect(new Date(reservation.recordedAt).toISOString()).toBe(reservation.recordedAt);
    });

    it("앞 호출이 완료되기 전 같은 matchKey를 다시 예약하지 않는다", () => {
      const store = create();
      store.createSession("s1");
      store.reserve({ sessionId: "s1", request: request("a") });
      expect(codeOf(() => store.reserve({ sessionId: "s1", request: request("a") }))).toBe(
        "CONCURRENT_MATCH",
      );
    });

    it("끝난 세션에는 예약하지 않는다", () => {
      const store = create();
      store.createSession("s1");
      store.finish("s1", "completed");
      expect(codeOf(() => store.reserve({ sessionId: "s1", request: request() }))).toBe(
        "SESSION_NOT_RUNNING",
      );
    });
  });

  describe("complete", () => {
    it("예약되지 않은 interactionId를 거절한다", () => {
      const store = create();
      store.createSession("s1");
      expect(
        codeOf(() =>
          store.complete({ sessionId: "s1", interactionId: "없음", outcome: outcome() }),
        ),
      ).toBe("INTERACTION_NOT_FOUND");
    });

    it("이미 완료된 interaction을 다시 완료하지 않는다 — 저장된 응답을 덮어쓰지 않는다", () => {
      const store = create();
      store.createSession("s1");
      const interactionId = recordOne(store, "s1", "a");
      expect(
        codeOf(() => store.complete({ sessionId: "s1", interactionId, outcome: outcome(500) })),
      ).toBe("INTERACTION_ALREADY_COMPLETE");
    });
  });

  describe("lookup", () => {
    it("완료되지 않은 세션은 Replay 원본이 될 수 없다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      expect(
        codeOf(() =>
          store.lookup({
            sourceSessionId: "s1",
            protocol: "http",
            matchKey: "a",
            occurrence: 0,
          }),
        ),
      ).toBe("REPLAY_SOURCE_INVALID");
    });

    it("protocol·matchKey·occurrence가 모두 맞아야 찾는다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      recordOne(store, "s1", "a");
      store.finish("s1", "completed");

      const base = { sourceSessionId: "s1", protocol: "http" } as const;
      expect(store.lookup({ ...base, matchKey: "a", occurrence: 0 })?.occurrence).toBe(0);
      expect(store.lookup({ ...base, matchKey: "a", occurrence: 1 })?.occurrence).toBe(1);
      expect(store.lookup({ ...base, matchKey: "a", occurrence: 2 })).toBeUndefined();
      expect(store.lookup({ ...base, matchKey: "b", occurrence: 0 })).toBeUndefined();
    });

    it("다른 세션의 interaction을 섞어서 주지 않는다", () => {
      const store = create();
      store.createSession("s1");
      store.createSession("s2");
      recordOne(store, "s1", "a");
      store.finish("s1", "completed");
      store.finish("s2", "completed");

      expect(
        store.lookup({ sourceSessionId: "s2", protocol: "http", matchKey: "a", occurrence: 0 }),
      ).toBeUndefined();
    });
  });

  describe("finish", () => {
    it("incomplete가 남은 채 completed로 끝내지 않고, 세션을 failed로 만든다", () => {
      const store = create();
      store.createSession("s1");
      store.reserve({ sessionId: "s1", request: request("a") });

      expect(codeOf(() => store.finish("s1", "completed"))).toBe("INCOMPLETE_SESSION");
      expect(store.read("s1")?.status).toBe("failed");
    });

    it("failed로 끝낸 세션은 Replay 원본이 되지 않는다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      store.finish("s1", "failed");

      expect(
        codeOf(() =>
          store.lookup({ sourceSessionId: "s1", protocol: "http", matchKey: "a", occurrence: 0 }),
        ),
      ).toBe("REPLAY_SOURCE_INVALID");
    });

    it("이미 끝난 세션을 다시 끝내도 상태가 바뀌지 않는다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      store.finish("s1", "completed");

      expect(store.finish("s1", "failed").status).toBe("completed");
      expect(store.read("s1")?.status).toBe("completed");
    });

    it("요약은 interaction 수를 담고 record 모드로 표시된다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      recordOne(store, "s1", "b");

      expect(store.finish("s1", "completed")).toMatchObject({
        mode: "record",
        sessionId: "s1",
        status: "completed",
        interactionCount: 2,
      });
    });
  });

  describe("read", () => {
    it("없는 세션은 undefined다 — 던지지 않는다", () => {
      expect(create().read("없음")).toBeUndefined();
    });

    it("스냅샷을 고쳐도 저장본이 바뀌지 않는다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");

      const snapshot = store.read("s1");
      expect(() => {
        (snapshot as { status: string }).status = "failed";
      }).toThrow();
      expect(store.read("s1")?.status).toBe("running");
    });

    it("완료된 interaction은 outcome을, 예약만 된 것은 status로 구분된다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");
      store.reserve({ sessionId: "s1", request: request("b") });

      const interactions = store.read("s1")?.interactions ?? [];
      expect(interactions.map((item) => item.status)).toEqual(["complete", "incomplete"]);
      expect(interactions[0]?.outcome).toBeDefined();
      expect(interactions[1]?.outcome).toBeUndefined();
    });
  });
  describe("INCOMPLETE_SESSION 진단", () => {
    it("어떤 호출이 미완료인지 알려준다 — 원인 없이 세션만 실패시키지 않는다", () => {
      const store = create();
      store.createSession("s1");
      store.reserve({ sessionId: "s1", request: request("a") });

      let message = "";
      try {
        store.finish("s1", "completed");
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain("완료되지 않은 외부 호출이 1건");
      // 마스킹된 display 를 쓰므로 그대로 보여도 안전하다.
      expect(message).toContain("GET https://example.com/a");
      // 무엇을 하면 되는지까지 말한다.
      expect(message).toContain("JSON을 돌려주는지");
    });
  });

  describe("close", () => {
    it("여러 번 닫아도 안전하다 — 부모가 정상·실패 경로 양쪽에서 닫는다", () => {
      const store = create();
      store.createSession("s1");

      expect(() => {
        store.close();
        store.close();
      }).not.toThrow();
    });
  });

  describe("호출자 격리", () => {
    it("넘긴 객체를 얼리지 않는다 — 호출자는 자기 객체를 계속 쓸 수 있다", () => {
      const store = create();
      store.createSession("s1");
      const sent = request("a");
      const reservation = store.reserve({ sessionId: "s1", request: sent });
      const sentOutcome = outcome();
      store.complete({
        sessionId: "s1",
        interactionId: reservation.interactionId,
        outcome: sentOutcome,
      });

      // 저장본을 지키려고 호출자 객체까지 얼리면, 그 객체를 재사용하려던 코드가 죽는다.
      // SQLite 는 넣을 때 직렬화해 호출자를 안 건드리므로, 여기가 갈리면 저장 매체에 따라
      // 동작이 달라진다 — 계약이 없애려는 것이 그 차이다.
      expect(() => {
        (sent.display as { method: string }).method = "POST";
        (sentOutcome as { status: number }).status = 500;
      }).not.toThrow();
    });

    it("넘긴 뒤 호출자가 객체를 고쳐도 저장본은 그대로다", () => {
      const store = create();
      store.createSession("s1");
      const sent = request("a");
      store.reserve({ sessionId: "s1", request: sent });

      (sent.display as { method: string }).method = "POST";

      expect(store.read("s1")?.interactions[0]?.request.display.method).toBe("GET");
    });
  });

  describe("스냅샷 격리", () => {
    it("스냅샷의 중첩 값을 고쳐도 저장본이 바뀌지 않는다", () => {
      const store = create();
      store.createSession("s1");
      recordOne(store, "s1", "a");

      const snapshot = store.read("s1")?.interactions[0];
      if (snapshot?.outcome === undefined) throw new Error("스냅샷을 읽지 못했습니다.");

      // 최상위만 얼려 두면 이 두 줄로 저장본이 바뀐다. 그러면 이미 계산된 matchKey 와
      // 저장된 display 가 어긋나고, 진단이 기록과 다른 것을 보여준다.
      //
      // 얼려 있으면 strict mode 에서 던진다. 던지든 무시되든 **저장본만 그대로면** 된다 —
      // 계약이 요구하는 것은 freeze 라는 수단이 아니라 오염되지 않는다는 성질이다.
      try {
        (snapshot.request.display as { method: string }).method = "DELETE";
      } catch {
        // 성질만 보므로 던지는 것 자체는 판정 대상이 아니다.
      }
      try {
        (snapshot.outcome as { status: number }).status = 500;
      } catch {
        // 위와 같다.
      }

      const stored = store.read("s1")?.interactions[0];
      if (stored?.outcome === undefined) throw new Error("저장본을 읽지 못했습니다.");
      expect(stored.request.display.method).toBe("GET");
      expect((stored.outcome as { status: number }).status).toBe(200);
    });
  });
});
