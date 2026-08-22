/**
 * `@mcpeak/record/external` — External Record/Replay 의 **공식 진입점**이다.
 *
 * 여기 있는 것은 CLI 와 dashboard 가 실제로 필요로 하는 최소한이다. subpath 를 여는 순간
 * 이 목록은 공개 계약이 되고, **넣는 것은 쉽지만 빼는 것은 breaking** 이다. 그래서 "쓸 수도
 * 있는 것" 이 아니라 "지금 소비자가 부르는 것" 만 둔다.
 *
 * 특히 아래는 **의도적으로 내보내지 않는다.**
 *
 * - `child/bootstrap.mjs`·`child/fetch-adapter.mjs` — 자식 프로세스에서만 돈다. 호출자는
 *   경로조차 알 필요가 없다. `startExternalCoordinator` 가 자기 `import.meta.url` 기준으로
 *   해석해 `childEnvironment` 에 실어 준다.
 * - Coordinator 의 protocol 처리 함수 — loopback endpoint 의 형태는 내부 구현이다.
 *   공개하면 endpoint 를 바꿀 때마다 breaking 이 된다.
 * - Store 의 스키마 세부(`SQLITE_STORE_VERSION`, DDL, 행 타입) — 마이그레이션은 Store 안에서
 *   끝나야 하고, 밖에서 스키마를 읽기 시작하면 그 자유가 사라진다.
 * - `createMemorySessionStore` — 테스트 하네스용이다. 테스트는 상대 경로로 부르면 되고,
 *   공개하면 "인메모리로 녹화하면 어디 남나요" 라는 답할 수 없는 질문이 따라온다.
 */

export type { ExternalCoordinatorHandle } from "./coordinator.js";
export { startExternalCoordinator } from "./coordinator.js";
/** 실패를 분기해 사용자에게 다르게 보여주려면 code 가 필요하다(REPLAY_MISS 와 그 외). */
export type { ExternalErrorCode } from "./errors.js";
export { ExternalRecordReplayError } from "./errors.js";
/** `finish()` 의 반환값. 소비자가 consumed/unused 개수를 보고할 때 쓴다. */
export type { ReplayMissDetail, SessionSummary } from "./session-store.js";
/**
 * `loadSession` 이 돌려주는 것. 대시보드가 목록과 타임라인을 그리려면 상호작용까지 필요하다.
 * 스키마 세부(행 타입·DDL)는 여전히 안 나간다 — 나가는 것은 우리가 정의한 도메인 모양뿐이다.
 */
export type {
  InteractionStatus,
  SessionSnapshot,
  SessionStatus,
  StoredInteraction,
} from "./session-store.js";
export type { SqliteSessionStoreOptions } from "./session-store-sqlite.js";
export { createSqliteSessionStore, loadSession } from "./session-store-sqlite.js";
