import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NormalizedExternalRequest,
  StoredExternalOutcome,
} from "../../src/external/protocol.js";
import {
  createSqliteSessionStore,
  SQLITE_STORE_VERSION,
} from "../../src/external/session-store-sqlite.js";

/**
 * 계약(`session-store-contract.test.ts`)이 아니라 **SQLite 구현에만 있는 성질**을 본다.
 * 계약은 매체를 가리지 않는 스펙이고, 여기는 "영속이라서 되는 것" 을 확인한다.
 */

const directories: string[] = [];
const opened: { close(): void }[] = [];

/** 연 Store 를 모아 두고 정리 때 닫는다. Windows 는 핸들이 열린 파일을 지우지 못한다. */
const open = (path?: string) => {
  const store =
    path === undefined ? createSqliteSessionStore() : createSqliteSessionStore({ path });
  opened.push(store);
  return store;
};

/** 계약 밖의 테이블을 직접 볼 때 쓴다. 열린 핸들은 정리 때 함께 닫는다. */
const openRaw = (path: string) => {
  const db = new DatabaseSync(path);
  opened.push({ close: () => db.close() });
  return db;
};

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const newDbPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "mcpeak-sqlite-"));
  directories.push(directory);
  return join(directory, "sessions.db");
};

const request = (matchKey: string): NormalizedExternalRequest => ({
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

const outcome = (): StoredExternalOutcome => ({
  kind: "response",
  status: 200,
  statusText: "OK",
  headers: [["content-type", "application/json"]],
  url: "https://example.com/a",
  body: { weather: "sunny" },
});

describe("SQLite Session Store", () => {
  it("프로세스를 새로 열어도 녹화가 남는다 — 이것이 메모리 구현과 다른 점이다", () => {
    const path = newDbPath();

    const recording = open(path);
    recording.createSession("s1");
    const reservation = recording.reserve({ sessionId: "s1", request: request("a") });
    recording.complete({
      sessionId: "s1",
      interactionId: reservation.interactionId,
      outcome: outcome(),
    });
    recording.finish("s1", "completed");

    // 같은 파일을 새 Store 인스턴스로 연다. 프로세스가 다시 뜬 상황과 같다.
    const replaying = open(path);
    const found = replaying.lookup({
      sourceSessionId: "s1",
      protocol: "http",
      matchKey: "a",
      occurrence: 0,
    });

    expect(found?.outcome).toEqual(outcome());
    expect(replaying.read("s1")?.status).toBe("completed");
  });

  it("저장한 request를 그대로 돌려준다 — 불투명 JSON 칼럼을 왕복시킨다", () => {
    const path = newDbPath();
    const store = open(path);
    store.createSession("s1");
    const original = request("round-trip");
    const reservation = store.reserve({ sessionId: "s1", request: original });
    store.complete({
      sessionId: "s1",
      interactionId: reservation.interactionId,
      outcome: outcome(),
    });

    const reopened = open(path);
    const stored = reopened.read("s1")?.interactions[0];

    expect(stored?.request).toEqual(original);
  });

  it("실패로 끝난 세션도 실패인 채로 남는다", () => {
    const path = newDbPath();
    const store = open(path);
    store.createSession("s1");
    store.reserve({ sessionId: "s1", request: request("a") });
    expect(() => store.finish("s1", "completed")).toThrow();

    expect(open(path).read("s1")?.status).toBe("failed");
  });

  it("스키마 버전을 기록한다 — 나중에 마이그레이션 판단의 근거가 된다", () => {
    const path = newDbPath();
    open(path);

    // meta 는 계약에 없는 SQLite 내부 테이블이라 직접 확인한다.
    const db = openRaw(path);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get() as {
      value: string;
    };

    expect(Number(row.value)).toBe(SQLITE_STORE_VERSION);
  });

  it("같은 자리에 두 건이 생기지 않도록 DB가 막는다", () => {
    const path = newDbPath();
    const store = open(path);
    store.createSession("s1");
    const first = store.reserve({ sessionId: "s1", request: request("a") });
    store.complete({ sessionId: "s1", interactionId: first.interactionId, outcome: outcome() });

    // (session, protocol, matchKey, occurrence) 는 UNIQUE 다. 같은 자리에 두 건이 있으면
    // Replay 가 어느 쪽을 돌려줄지 실행 순서에 달리므로 결정론성이 깨진다.
    const db = openRaw(path);
    expect(() =>
      db
        .prepare(
          `INSERT INTO interactions
             (session_id, interaction_id, ordinal, occurrence, recorded_at, status, protocol, match_key, request_json)
           VALUES ('s1', 's1:99', 99, 0, '2026-01-01T00:00:00.000Z', 'incomplete', 'http', 'a', '{}')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("인메모리 모드는 파일을 만들지 않는다", () => {
    const store = open();
    store.createSession("s1");

    expect(store.read("s1")?.status).toBe("running");
  });
});
