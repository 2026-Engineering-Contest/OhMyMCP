import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NormalizedExternalRequest,
  StoredExternalOutcome,
} from "../../src/external/protocol.js";
import { createSqliteSessionStore, loadSession } from "../../src/external/session-store-sqlite.js";

/**
 * `loadSession` 은 Store 가 아니라 **판별기**다. 대시보드가 프로젝트를 훑으며 파일마다
 * 부르는 자리이므로, 여기서 보는 것은 두 가지다 — "세션을 제대로 읽는가" 와 **"세션이
 * 아닌 파일에 아무 짓도 하지 않는가"**. 후자가 이 함수의 안전선이다.
 */

const directories: string[] = [];
const opened: { close(): void }[] = [];

const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mcpeak-load-session-"));
  directories.push(dir);
  return dir;
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
  body: { ok: true },
});

/** 상호작용 하나가 든 세션 파일을 만들고 닫는다. 닫아야 Windows 에서 지울 수 있다. */
const writeSession = (path: string, matchKeys: readonly string[] = ["a"]): void => {
  const store = createSqliteSessionStore({ path });
  store.createSession("default");
  for (const key of matchKeys) {
    const reservation = store.reserve({ sessionId: "default", request: request(key) });
    store.complete({
      sessionId: "default",
      interactionId: reservation.interactionId,
      outcome: outcome(),
    });
  }
  store.finish("default", "completed");
  store.close();
};

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSession", () => {
  it("녹화한 세션을 기록 순서대로 읽는다", () => {
    const path = join(newDir(), "session.db");
    writeSession(path, ["a", "b", "c"]);

    const snapshot = loadSession(path);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.sessionId).toBe("default");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.interactions.map((i) => i.request.matchKey)).toEqual(["a", "b", "c"]);
    expect(snapshot?.interactions[0]?.outcome).toMatchObject({ kind: "response", status: 200 });
  });

  /**
   * 이 함수의 안전선이다. 기본 모드로 열면 `node:sqlite` 가 없는 경로에 빈 DB 를 만들고
   * 스키마까지 심는다. 대시보드는 프로젝트 전체를 훑으므로, 그 순간 사용자 저장소에
   * 쓰레기 `.db` 가 깔린다.
   */
  it("없는 경로면 null이고, 파일을 만들지 않는다", () => {
    const path = join(newDir(), "없는파일.db");

    expect(loadSession(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("SQLite가 아닌 파일이면 null이고, 내용을 건드리지 않는다", () => {
    const path = join(newDir(), "not-a-db.json");
    writeFileSync(path, '{"interactions":[]}', "utf8");

    expect(loadSession(path)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("우리 스키마가 아닌 SQLite면 null이다", () => {
    const path = join(newDir(), "other-schema.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE 무관한표 (a TEXT);");
    db.close();

    expect(loadSession(path)).toBeNull();
  });

  it("세션 행이 없는 빈 세션 파일이면 null이다", () => {
    const path = join(newDir(), "empty.db");
    // 스키마만 만들고 세션은 넣지 않는다. `createSession` 전의 상태다.
    const store = createSqliteSessionStore({ path });
    store.close();

    expect(loadSession(path)).toBeNull();
  });

  it("읽어도 원본 파일을 수정하지 않는다", () => {
    const path = join(newDir(), "session.db");
    writeSession(path);
    const before = statSync(path).mtimeMs;

    loadSession(path);

    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("같은 파일을 두 번 읽으면 같은 결과다", () => {
    const path = join(newDir(), "session.db");
    writeSession(path, ["a", "b"]);

    expect(loadSession(path)).toEqual(loadSession(path));
  });
});
