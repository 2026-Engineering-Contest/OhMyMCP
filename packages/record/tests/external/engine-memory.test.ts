import { describe, expect, it } from "vitest";
import { createRecordEngine, createReplayEngine } from "../../src/external/engine.js";
import type {
  NormalizedExternalRequest,
  StoredExternalOutcome,
} from "../../src/external/protocol.js";
import { createMemorySessionStore } from "../../src/external/session-store.js";

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

const outcome = (value: number): StoredExternalOutcome => ({
  kind: "response",
  status: 200,
  statusText: "OK",
  headers: [["content-type", "application/json"]],
  url: "https://example.com/result",
  body: { value },
});

describe("memory external engine", () => {
  it("같은 matchKey에 occurrence를 0부터 부여하고 Replay에서 한 번씩 소비한다", () => {
    const store = createMemorySessionStore();
    const record = createRecordEngine({ sessionId: "source", store });

    const first = record.begin(request());
    expect(first).toMatchObject({ ordinal: 0, occurrence: 0 });
    expect(Number.isNaN(Date.parse(first.recordedAt))).toBe(false);
    record.complete({ interactionId: first.interactionId, outcome: outcome(1) });

    const second = record.begin(request());
    expect(second).toMatchObject({ ordinal: 1, occurrence: 1 });
    record.complete({ interactionId: second.interactionId, outcome: outcome(2) });
    record.finish("completed");

    const replay = createReplayEngine({ sourceSessionId: "source", store });
    expect(replay.lookup(request()).outcome).toEqual(outcome(1));
    expect(replay.lookup(request()).outcome).toEqual(outcome(2));
    expect(() => replay.lookup(request())).toThrowError(
      expect.objectContaining({ code: "REPLAY_MISS" }),
    );
    // 이 마지막 호출이 곧 miss 다 — occurrence 2 짜리 저장본이 없다.
    expect(replay.finish("completed")).toMatchObject({
      consumedCount: 2,
      unusedCount: 0,
      misses: [{ method: "GET", occurrence: 2 }],
    });
  });

  it("앞 호출이 complete되기 전 같은 matchKey begin을 거절한다", () => {
    const store = createMemorySessionStore();
    const record = createRecordEngine({ sessionId: "concurrent", store });
    record.begin(request());

    expect(() => record.begin(request())).toThrowError(
      expect.objectContaining({ code: "CONCURRENT_MATCH" }),
    );
  });

  it("incomplete interaction이 있으면 세션을 failed로 만들고 Replay 원본으로 거절한다", () => {
    const store = createMemorySessionStore();
    const record = createRecordEngine({ sessionId: "broken", store });
    record.begin(request());

    expect(() => record.finish("completed")).toThrowError(
      expect.objectContaining({ code: "INCOMPLETE_SESSION" }),
    );
    expect(store.read("broken")?.status).toBe("failed");
    expect(() => createReplayEngine({ sourceSessionId: "broken", store })).toThrowError(
      expect.objectContaining({ code: "REPLAY_SOURCE_INVALID" }),
    );
  });

  it("세션이 아예 없는 것과 미완료인 것을 다른 code 로 가른다(#260)", () => {
    // 두 실패는 사용자가 할 일이 정반대다 — 앞은 경로를 고치거나 녹화를 하는 것이고,
    // 뒤는 녹화를 다시 뜨는 것이다. 한 code 로 합치면 CLI 가 문장을 고를 수 없다.
    const store = createMemorySessionStore();

    expect(() => createReplayEngine({ sourceSessionId: "없음", store })).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
    );

    const record = createRecordEngine({ sessionId: "미완료", store });
    record.begin(request());
    expect(() => record.finish("completed")).toThrowError(
      expect.objectContaining({ code: "INCOMPLETE_SESSION" }),
    );
    expect(() => createReplayEngine({ sourceSessionId: "미완료", store })).toThrowError(
      expect.objectContaining({ code: "REPLAY_SOURCE_INVALID" }),
    );
  });

  it("Replay에 남은 interaction은 실패가 아니라 unused 요약으로 반환한다", () => {
    const store = createMemorySessionStore();
    const record = createRecordEngine({ sessionId: "partial", store });
    for (const key of ["a", "b"]) {
      const reservation = record.begin(request(key));
      record.complete({ interactionId: reservation.interactionId, outcome: outcome(1) });
    }
    record.finish("completed");

    const replay = createReplayEngine({ sourceSessionId: "partial", store });
    replay.lookup(request("a"));
    expect(replay.finish("completed")).toMatchObject({
      consumedCount: 1,
      unusedCount: 1,
      misses: [],
    });
  });
});

describe("REPLAY_MISS 진단", () => {
  it("어떤 호출이 빠졌는지와 다음에 무엇을 할지 알려준다", () => {
    const store = createMemorySessionStore();
    store.createSession("s1");
    const reservation = store.reserve({ sessionId: "s1", request: request("recorded") });
    store.complete({
      sessionId: "s1",
      interactionId: reservation.interactionId,
      outcome: outcome(1),
    });
    store.finish("s1", "completed");

    const replay = createReplayEngine({ sourceSessionId: "s1", store });
    let message = "";
    try {
      replay.lookup(request("never-recorded"));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("실제 네트워크는 호출하지 않았습니다");
    // 무엇이 빠졌는지 — 마스킹된 display 를 쓴다.
    expect(message).toContain("GET https://example.com/never-recorded");
    // 왜 그런지와 어떻게 고치는지.
    expect(message).toContain("matchKey");
    expect(message).toContain("녹화를 다시 하거나");
  });

  it("MCP 오류 채널과 별개로 finish() 요약에 구조화된 진단을 남긴다(#259)", () => {
    // 이 목록이 정본이다 — 위 message 는 테스트 대상 서버가 relay 해야만 사용자에게
    // 닿고, 그 relay 를 `runner` 가 신뢰하지 않아 이스케이프·잘라낸다.
    const store = createMemorySessionStore();
    store.createSession("s2");
    store.finish("s2", "completed");

    const replay = createReplayEngine({ sourceSessionId: "s2", store });
    expect(() => replay.lookup(request("never-recorded"))).toThrowError(
      expect.objectContaining({ code: "REPLAY_MISS" }),
    );

    const summary = replay.finish("completed");
    expect(summary.misses).toEqual([
      {
        method: "GET",
        url: "https://example.com/never-recorded",
        occurrence: 0,
        matchKeyPrefix: "never-record",
      },
    ]);
  });

  it("miss 원소를 소비자가 고쳐도 저장된 값은 오염되지 않는다", () => {
    const store = createMemorySessionStore();
    store.createSession("s3");
    store.finish("s3", "completed");

    const replay = createReplayEngine({ sourceSessionId: "s3", store });
    expect(() => replay.lookup(request("never-recorded"))).toThrowError(
      expect.objectContaining({ code: "REPLAY_MISS" }),
    );

    const first = replay.finish("completed");
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 얼려진 객체를 강제로 고쳐 보는 테스트다.
      (first.misses[0] as any).url = "https://tampered.example";
    }).toThrow(TypeError);
    expect(replay.finish("completed").misses[0]?.url).toBe("https://example.com/never-recorded");
  });
});
