import { externalError } from "./errors.js";
import type { NormalizedExternalRequest, StoredExternalOutcome } from "./protocol.js";
import * as message from "./store-messages.js";

export type SessionStatus = "running" | "completed" | "failed";
export type InteractionStatus = "incomplete" | "complete";

export interface ReserveInteractionInput {
  readonly sessionId: string;
  readonly request: NormalizedExternalRequest;
}

export interface InteractionReservation {
  readonly interactionId: string;
  readonly ordinal: number;
  readonly occurrence: number;
  readonly recordedAt: string;
}

export interface CompleteInteractionInput {
  readonly sessionId: string;
  readonly interactionId: string;
  readonly outcome: StoredExternalOutcome;
}

export interface LookupInteractionInput {
  readonly sourceSessionId: string;
  readonly protocol: NormalizedExternalRequest["protocol"];
  readonly matchKey: string;
  readonly occurrence: number;
}

export interface StoredInteraction extends InteractionReservation {
  readonly status: InteractionStatus;
  readonly request: NormalizedExternalRequest;
  readonly outcome?: StoredExternalOutcome;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly interactions: readonly StoredInteraction[];
}

export interface RecordSessionSummary {
  readonly mode: "record";
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly interactionCount: number;
  readonly consumedCount: 0;
  readonly unusedCount: 0;
}

/**
 * 재생 원본에서 찾지 못한 호출 하나. 사용자에게 보일 진단이라 `display` 필드만 담는다
 * (ADR-0053 — 마스킹된 쪽이라 그대로 보여도 안전하다). `matchKey` 는 앞 12자만 — 세션 안에서
 * 구분하기에는 이만큼이면 되고, 전체 64자는 한 줄을 삼킨다.
 */
export interface ReplayMissDetail {
  readonly method: string;
  readonly url: string;
  readonly occurrence: number;
  readonly matchKeyPrefix: string;
}

export interface ReplaySessionSummary {
  readonly mode: "replay";
  readonly sourceSessionId: string;
  readonly status: "completed" | "failed";
  readonly interactionCount: number;
  readonly consumedCount: number;
  readonly unusedCount: number;
  /**
   * 이번 실행에서 원본에 없어 실패한 호출들. **MCP 오류 채널을 거치지 않은 원본이다** — 그
   * 채널은 `runner` 가 테스트 대상 서버의 텍스트로 취급해 이스케이프·잘라내므로, 우리 자신의
   * 진단이 거기 실리면 서버 텍스트와 똑같이 망가진다(#259). CLI 는 이 목록을 별도 블록으로
   * 그대로 보여준다.
   */
  readonly misses: readonly ReplayMissDetail[];
}

export type SessionSummary = RecordSessionSummary | ReplaySessionSummary;

export interface SessionStore {
  createSession(sessionId: string): void;
  reserve(input: ReserveInteractionInput): InteractionReservation;
  complete(input: CompleteInteractionInput): void;
  lookup(input: LookupInteractionInput): StoredInteraction | undefined;
  finish(sessionId: string, status: "completed" | "failed"): RecordSessionSummary;
  read(sessionId: string): SessionSnapshot | undefined;
  /**
   * 저장 자원을 놓는다. 부모가 세션을 다 쓰고 마지막에 부른다(ADR-0052 의 명시적 수명주기).
   *
   * 메모리 구현에는 놓을 것이 없지만 계약에 둔다. 없으면 파일 기반 구현이 핸들을 붙든 채
   * 남고, 호출자가 "이 Store 는 닫아야 하나" 를 알려면 구현 종류를 알아야 한다 — 갈아 끼울
   * 수 있다는 계약의 취지가 거기서 깨진다. **여러 번 불러도 안전해야 한다.**
   */
  close(): void;
}

interface MutableInteraction {
  interactionId: string;
  ordinal: number;
  occurrence: number;
  recordedAt: string;
  status: InteractionStatus;
  request: NormalizedExternalRequest;
  outcome?: StoredExternalOutcome;
}

interface MutableSession {
  sessionId: string;
  status: SessionStatus;
  interactions: MutableInteraction[];
}

/**
 * 저장할 값을 **복사한 뒤 얼린다.** 양쪽이 각각 다른 문제를 막는다.
 *
 * **복사**는 호출자를 지킨다. 넘겨받은 객체를 그대로 얼리면 호출자 쪽에서도 불변이 되어,
 * 그 객체를 다시 쓰려던 코드가 `TypeError` 로 죽는다. SQLite 구현은 넣을 때 직렬화하므로
 * 호출자 객체가 멀쩡한데, 메모리만 얼리면 **저장 매체에 따라 동작이 갈린다** — 계약이
 * 없애려는 것이 정확히 그 차이다.
 *
 * **얼리기**는 저장본을 지킨다. 스냅샷은 최상위만 얼리고 `request`·`outcome` 은 참조를 그대로
 * 넘기므로, 얼려 두지 않으면 `snapshot.request.display.method = "DELETE"` 한 줄로 저장본이
 * 바뀐다. 그러면 이미 계산된 matchKey 와 저장된 `match` 가 어긋나고 Replay 가 기록과 다른
 * 것을 돌려준다.
 *
 * 읽을 때가 아니라 **쓸 때** 하는 이유는 `read` 가 반복 호출되기 때문이다. 넣을 때 한 번이면
 * 끝나고, 저장된 뒤 이 값들이 바뀔 일도 없다 — `status` 와 `outcome` 교체는 바깥 wrapper 에서
 * 일어난다.
 */
const freezeDeep = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    freezeDeep((value as Record<string, unknown>)[key]);
  }
};

const storedCopy = <T>(value: T): T => {
  const copy = structuredClone(value);
  freezeDeep(copy);
  return copy;
};

const interactionSnapshot = (value: MutableInteraction): StoredInteraction =>
  Object.freeze({
    interactionId: value.interactionId,
    ordinal: value.ordinal,
    occurrence: value.occurrence,
    recordedAt: value.recordedAt,
    status: value.status,
    request: value.request,
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
  });

const sessionSnapshot = (value: MutableSession): SessionSnapshot =>
  Object.freeze({
    sessionId: value.sessionId,
    status: value.status,
    interactions: Object.freeze(value.interactions.map(interactionSnapshot)),
  });

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, MutableSession>();

  const requiredSession = (sessionId: string): MutableSession => {
    const session = sessions.get(sessionId);
    if (session === undefined)
      externalError("SESSION_NOT_FOUND", message.sessionNotFound(sessionId));
    return session;
  };

  return {
    createSession(sessionId) {
      if (sessionId.length === 0) externalError("REQUEST_INVALID", "sessionId가 비어 있습니다.");
      if (sessions.has(sessionId))
        externalError("SESSION_ALREADY_EXISTS", message.sessionAlreadyExists(sessionId));
      sessions.set(sessionId, { sessionId, status: "running", interactions: [] });
    },

    reserve({ sessionId, request }) {
      const session = requiredSession(sessionId);
      if (session.status !== "running")
        externalError("SESSION_NOT_RUNNING", message.sessionNotRunning(sessionId));
      const sameKey = session.interactions.filter(
        (interaction) =>
          interaction.request.protocol === request.protocol &&
          interaction.request.matchKey === request.matchKey,
      );
      if (sameKey.some((interaction) => interaction.status === "incomplete"))
        externalError("CONCURRENT_MATCH", message.concurrentMatch);
      const ordinal = session.interactions.length;
      const reservation = Object.freeze({
        interactionId: `${sessionId}:${ordinal}`,
        ordinal,
        occurrence: sameKey.length,
        recordedAt: new Date().toISOString(),
      });
      session.interactions.push({
        ...reservation,
        status: "incomplete",
        request: storedCopy(request),
      });
      return reservation;
    },

    complete({ sessionId, interactionId, outcome }) {
      const session = requiredSession(sessionId);
      if (session.status !== "running")
        externalError("SESSION_NOT_RUNNING", message.sessionNotRunning(sessionId));
      const interaction = session.interactions.find((item) => item.interactionId === interactionId);
      if (interaction === undefined)
        externalError("INTERACTION_NOT_FOUND", message.interactionNotFound);
      if (interaction.status === "complete")
        externalError("INTERACTION_ALREADY_COMPLETE", message.interactionAlreadyComplete);
      interaction.status = "complete";
      interaction.outcome = storedCopy(outcome);
    },

    lookup({ sourceSessionId, protocol, matchKey, occurrence }) {
      const session = requiredSession(sourceSessionId);
      if (session.status !== "completed")
        externalError("REPLAY_SOURCE_INVALID", message.replaySourceInvalid(sourceSessionId));
      const interaction = session.interactions.find(
        (item) =>
          item.status === "complete" &&
          item.request.protocol === protocol &&
          item.request.matchKey === matchKey &&
          item.occurrence === occurrence,
      );
      return interaction === undefined ? undefined : interactionSnapshot(interaction);
    },

    finish(sessionId, status) {
      const session = requiredSession(sessionId);
      if (session.status !== "running") {
        return Object.freeze({
          mode: "record",
          sessionId,
          status: session.status,
          interactionCount: session.interactions.length,
          consumedCount: 0,
          unusedCount: 0,
        });
      }
      const incomplete = session.interactions.filter((item) => item.status === "incomplete");
      if (status === "completed" && incomplete.length > 0) {
        session.status = "failed";
        externalError("INCOMPLETE_SESSION", message.incompleteSession(sessionId, incomplete));
      }
      session.status = status;
      return Object.freeze({
        mode: "record",
        sessionId,
        status: session.status,
        interactionCount: session.interactions.length,
        consumedCount: 0,
        unusedCount: 0,
      });
    },

    read(sessionId) {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : sessionSnapshot(session);
    },

    close() {
      // 메모리 구현은 놓을 자원이 없다. 계약을 맞추기 위한 no-op 이다.
    },
  };
}
