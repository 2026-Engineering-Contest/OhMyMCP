import { DatabaseSync } from "node:sqlite";
import { externalError } from "./errors.js";
import type { NormalizedExternalRequest, StoredExternalOutcome } from "./protocol.js";
import type {
  InteractionReservation,
  RecordSessionSummary,
  SessionSnapshot,
  SessionStatus,
  SessionStore,
  StoredInteraction,
} from "./session-store.js";
import * as message from "./store-messages.js";

/**
 * 영속 `SessionStore`. 같은 계약(`session-store-contract.test.ts`)을 메모리 구현과 공유한다.
 *
 * **부모만 이 파일을 연다**(ADR-0052). 자식 Adapter 는 DB 경로도 라이브러리도 알지 못하고,
 * loopback Coordinator 로만 말한다. 그래서 여기서 `node:sqlite` 를 import 해도 자식의
 * 런타임 요구사항은 늘지 않는다.
 *
 * `node:sqlite` 는 Node 22.13 부터 플래그 없이 쓸 수 있고, 저장소의 최소 버전은 22.18 이다
 * (ADR-0054). Node 22.x 는 실행마다 `ExperimentalWarning` 을 stderr 에 찍을 수 있는데, 이
 * 모듈은 **프로세스 전역 warning 설정을 건드리지 않는다** — 라이브러리가 호출자의 전역
 * 상태를 바꾸면 안 되고, ADR-0054 도 전체 listener 제거를 금지했다. 표시 정책은 CLI 배선
 * (단계 C-2)에서 정한다.
 */

/** 물리 스키마 버전. 칼럼이나 인덱스가 바뀌면 올리고 마이그레이션을 붙인다. */
export const SQLITE_STORE_VERSION = 1;

/**
 * `interaction` 은 protocol 별 세부를 **불투명 JSON 칼럼**으로 담는다(ADR-0052).
 *
 * HTTP 전용 필드(method·url·헤더)를 공통 칼럼으로 올리면 두 번째 protocol 어댑터가
 * 들어올 때 스키마 마이그레이션이 필요해진다. 조회에 실제로 쓰는 것은
 * `(session_id, protocol, match_key, occurrence)` 넷뿐이라 그것만 칼럼으로 둔다.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS interactions (
  session_id     TEXT    NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  interaction_id TEXT    NOT NULL,
  ordinal        INTEGER NOT NULL,
  occurrence     INTEGER NOT NULL,
  recorded_at    TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('incomplete', 'complete')),
  protocol       TEXT    NOT NULL,
  match_key      TEXT    NOT NULL,
  request_json   TEXT    NOT NULL,
  outcome_json   TEXT,
  PRIMARY KEY (session_id, interaction_id)
);

-- Replay 의 유일한 조회 경로다. UNIQUE 인 이유는 같은 자리에 두 건이 생기면 어느 쪽을
-- 돌려줄지가 실행 순서에 달리기 때문이다 — 결정론성이 깨지는 자리라 DB 가 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS interactions_lookup
  ON interactions (session_id, protocol, match_key, occurrence);

-- read() 가 기록 순서대로 돌려주기 위한 것.
CREATE INDEX IF NOT EXISTS interactions_ordinal
  ON interactions (session_id, ordinal);
`;

interface InteractionRow {
  readonly interaction_id: string;
  readonly ordinal: number;
  readonly occurrence: number;
  readonly recorded_at: string;
  readonly status: "incomplete" | "complete";
  readonly request_json: string;
  readonly outcome_json: string | null;
}

const toInteraction = (row: InteractionRow): StoredInteraction =>
  Object.freeze({
    interactionId: row.interaction_id,
    ordinal: row.ordinal,
    occurrence: row.occurrence,
    recordedAt: row.recorded_at,
    status: row.status,
    request: Object.freeze(JSON.parse(row.request_json) as NormalizedExternalRequest),
    ...(row.outcome_json === null
      ? {}
      : { outcome: Object.freeze(JSON.parse(row.outcome_json) as StoredExternalOutcome) }),
  });

export interface SqliteSessionStoreOptions {
  /** DB 파일 경로. 생략하면 프로세스 수명만큼 사는 인메모리 DB 다. */
  readonly path?: string;
}

export function createSqliteSessionStore(options: SqliteSessionStoreOptions = {}): SessionStore {
  const db = new DatabaseSync(options.path ?? ":memory:");
  // 외래 키는 기본이 꺼져 있다. 세션을 지우면 interaction 이 남는 것을 DB 가 막게 한다.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('store_version', ?)").run(
    String(SQLITE_STORE_VERSION),
  );

  const statements = {
    insertSession: db.prepare("INSERT INTO sessions (session_id, status) VALUES (?, 'running')"),
    findSession: db.prepare("SELECT status FROM sessions WHERE session_id = ?"),
    setStatus: db.prepare("UPDATE sessions SET status = ? WHERE session_id = ?"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE session_id = ?"),
    sameKey: db.prepare(
      `SELECT COUNT(*) AS n, SUM(status = 'incomplete') AS pending
         FROM interactions
        WHERE session_id = ? AND protocol = ? AND match_key = ?`,
    ),
    insertInteraction: db.prepare(
      `INSERT INTO interactions
         (session_id, interaction_id, ordinal, occurrence, recorded_at, status, protocol, match_key, request_json)
       VALUES (?, ?, ?, ?, ?, 'incomplete', ?, ?, ?)`,
    ),
    findInteraction: db.prepare(
      "SELECT status FROM interactions WHERE session_id = ? AND interaction_id = ?",
    ),
    completeInteraction: db.prepare(
      `UPDATE interactions SET status = 'complete', outcome_json = ?
        WHERE session_id = ? AND interaction_id = ?`,
    ),
    lookup: db.prepare(
      `SELECT * FROM interactions
        WHERE session_id = ? AND protocol = ? AND match_key = ? AND occurrence = ?
          AND status = 'complete'`,
    ),
    listIncomplete: db.prepare(
      `SELECT * FROM interactions
        WHERE session_id = ? AND status = 'incomplete' ORDER BY ordinal`,
    ),
    listAll: db.prepare("SELECT * FROM interactions WHERE session_id = ? ORDER BY ordinal"),
  };

  const sessionStatus = (sessionId: string): SessionStatus | undefined => {
    const row = statements.findSession.get(sessionId) as { status: SessionStatus } | undefined;
    return row?.status;
  };

  const requiredStatus = (sessionId: string): SessionStatus => {
    const status = sessionStatus(sessionId);
    if (status === undefined)
      externalError("SESSION_NOT_FOUND", message.sessionNotFound(sessionId));
    return status;
  };

  const summary = (sessionId: string, status: SessionStatus): RecordSessionSummary => {
    const { n } = statements.countAll.get(sessionId) as { n: number };
    return Object.freeze({
      mode: "record",
      sessionId,
      status,
      interactionCount: n,
      consumedCount: 0,
      unusedCount: 0,
    });
  };

  return {
    createSession(sessionId) {
      if (sessionId.length === 0) externalError("REQUEST_INVALID", "sessionId가 비어 있습니다.");
      if (sessionStatus(sessionId) !== undefined)
        externalError("SESSION_ALREADY_EXISTS", message.sessionAlreadyExists(sessionId));
      statements.insertSession.run(sessionId);
    },

    reserve({ sessionId, request }) {
      if (requiredStatus(sessionId) !== "running")
        externalError("SESSION_NOT_RUNNING", message.sessionNotRunning(sessionId));

      const same = statements.sameKey.get(sessionId, request.protocol, request.matchKey) as {
        n: number;
        pending: number | null;
      };
      if ((same.pending ?? 0) > 0) externalError("CONCURRENT_MATCH", message.concurrentMatch);

      const { n: ordinal } = statements.countAll.get(sessionId) as { n: number };
      const reservation: InteractionReservation = Object.freeze({
        interactionId: `${sessionId}:${ordinal}`,
        ordinal,
        occurrence: same.n,
        recordedAt: new Date().toISOString(),
      });
      statements.insertInteraction.run(
        sessionId,
        reservation.interactionId,
        reservation.ordinal,
        reservation.occurrence,
        reservation.recordedAt,
        request.protocol,
        request.matchKey,
        JSON.stringify(request),
      );
      return reservation;
    },

    complete({ sessionId, interactionId, outcome }) {
      if (requiredStatus(sessionId) !== "running")
        externalError("SESSION_NOT_RUNNING", message.sessionNotRunning(sessionId));
      const row = statements.findInteraction.get(sessionId, interactionId) as
        | { status: "incomplete" | "complete" }
        | undefined;
      if (row === undefined) externalError("INTERACTION_NOT_FOUND", message.interactionNotFound);
      if (row.status === "complete")
        externalError("INTERACTION_ALREADY_COMPLETE", message.interactionAlreadyComplete);
      statements.completeInteraction.run(JSON.stringify(outcome), sessionId, interactionId);
    },

    lookup({ sourceSessionId, protocol, matchKey, occurrence }) {
      if (requiredStatus(sourceSessionId) !== "completed")
        externalError("REPLAY_SOURCE_INVALID", message.replaySourceInvalid(sourceSessionId));
      const row = statements.lookup.get(sourceSessionId, protocol, matchKey, occurrence) as
        | InteractionRow
        | undefined;
      return row === undefined ? undefined : toInteraction(row);
    },

    finish(sessionId, status) {
      const current = requiredStatus(sessionId);
      // 이미 끝난 세션은 요청한 status 를 무시하고 기존 상태를 그대로 돌려준다. 되살리면
      // 저장된 녹화의 의미가 사후에 바뀐다.
      if (current !== "running") return summary(sessionId, current);

      if (status === "completed") {
        const incomplete = (
          statements.listIncomplete.all(sessionId) as unknown as InteractionRow[]
        ).map(toInteraction);
        if (incomplete.length > 0) {
          statements.setStatus.run("failed", sessionId);
          externalError("INCOMPLETE_SESSION", message.incompleteSession(sessionId, incomplete));
        }
      }
      statements.setStatus.run(status, sessionId);
      return summary(sessionId, status);
    },

    read(sessionId) {
      const status = sessionStatus(sessionId);
      if (status === undefined) return undefined;
      const rows = statements.listAll.all(sessionId) as unknown as InteractionRow[];
      return Object.freeze<SessionSnapshot>({
        sessionId,
        status,
        interactions: Object.freeze(rows.map(toInteraction)),
      });
    },

    close() {
      // 두 번 닫는 것은 오류가 아니다. 부모가 정상 경로와 실패 경로 양쪽에서 닫으려 할 때
      // 호출자가 "이미 닫혔나" 를 추적하게 만들면, 그 추적을 빠뜨린 쪽에서 파일 핸들이 샌다.
      if (!db.isOpen) return;
      db.close();
    },
  };
}

/**
 * 세션 파일을 **읽기 전용**으로 열어 스냅샷을 준다. 세션 파일이 아니면 `null`.
 *
 * `Store` 가 아니라 **판별기**다. 호출자(대시보드)는 프로젝트를 훑으며 파일마다 "이게
 * 세션인가" 를 묻는다. 그 자리에서는 아닌 파일이 정상 입력이므로 **던지지 않고 `null` 을
 * 준다** — 훑는 쪽이 파일마다 try/catch 를 두르지 않아도 되게 하는 것이 이 계약의 목적이다.
 *
 * `readOnly: true` 가 핵심이다. 기본 모드로 열면 없는 경로에 **빈 DB 를 만들고 스키마까지
 * 심는다.** 그러면 프로젝트를 훑는 것만으로 사용자 저장소에 쓰레기 파일이 깔린다. 읽기
 * 전용으로 열면 없는 파일에서 그 자리에 실패하고 아무것도 만들지 않는다.
 *
 * 열리기는 했지만 내용이 세션이 아닌 경우(테이블 없음·다른 스키마·본문 손상)도 `null` 이다.
 * 판별기의 답은 "읽을 수 있는 세션인가" 하나뿐이고, 그 이유는 호출자가 쓸 데가 없다.
 */
export function loadSession(path: string): SessionSnapshot | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    // 없는 경로이거나 열 수 없는 파일이다.
    return null;
  }
  try {
    // 세션 파일 하나에 세션 하나다(CLI 의 `SESSION_ID`). 그래도 `ORDER BY` 를 붙이는 것은
    // 여러 건이 들어 있는 파일에서 **어느 것을 고를지가 실행마다 달라지지 않게** 하려는 것이다.
    const session = db
      .prepare("SELECT session_id, status FROM sessions ORDER BY session_id LIMIT 1")
      .get() as { session_id: string; status: SessionStatus } | undefined;
    if (session === undefined) return null;
    const rows = db
      .prepare(
        `SELECT interaction_id, ordinal, occurrence, recorded_at, status, request_json, outcome_json
           FROM interactions
          WHERE session_id = ?
          ORDER BY ordinal`,
      )
      .all(session.session_id) as unknown as InteractionRow[];
    return Object.freeze<SessionSnapshot>({
      sessionId: session.session_id,
      status: session.status,
      interactions: Object.freeze(rows.map(toInteraction)),
    });
  } catch {
    // SQLite 는 맞지만 우리 스키마가 아니거나 본문이 깨졌다.
    return null;
  } finally {
    if (db.isOpen) db.close();
  }
}
