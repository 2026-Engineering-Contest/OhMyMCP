/** 실행 도중 발생하는 이벤트 본문. RunRecord 경계에서 run별 id를 붙인다. */
export type RunEventInput =
  | { readonly kind: "stdout"; readonly html: string }
  | { readonly kind: "stderr"; readonly html: string }
  | { readonly kind: "question"; readonly question: PendingQuestion }
  | { readonly kind: "done"; readonly exitCode: number };

/** SSE `data:` 페이로드. id는 run 안에서 1부터 단조 증가하는 재연결 cursor다. */
export type RunEvent = RunEventInput & { readonly id: number };

/** 대화형 승인 질문. CLI 플로우가 순차적이므로 동시에 최대 1개만 pending이다. */
export type PendingQuestion =
  | { readonly id: string; readonly kind: "input"; readonly message: string }
  | {
      readonly id: string;
      readonly kind: "choose";
      readonly message: string;
      readonly choices: readonly string[];
    }
  | { readonly id: string; readonly kind: "confirm"; readonly message: string };

/** POST /api/runs — 어떤 플로우든 실행 시작은 이 하나로 받는다. */
export type StartRunRequest =
  | { readonly flow: "test"; readonly argv: readonly string[] }
  | { readonly flow: "generate"; readonly argv: readonly string[] }
  | { readonly flow: "repair"; readonly argv: readonly string[] };

export interface StartRunResponse {
  readonly runId: string;
}

export type RunStatus = "running" | "waiting-input" | "done" | "failed";

export interface RunSummary {
  readonly runId: string;
  readonly flow: StartRunRequest["flow"];
  readonly status: RunStatus;
  readonly exitCode: number | null;
}

/** POST /api/runs/:id/answer */
export interface AnswerRequest {
  readonly questionId: string;
  /** input → 문자열, choose → 선택지 문자열 그대로, confirm → "y" | "n" */
  readonly value: string;
}

/** 파일 리소스 공통. path는 프로젝트 루트 기준 상대경로다. */
export interface FileEntry {
  readonly path: string;
}

export interface FileContent {
  readonly path: string;
  readonly content: string;
  /** 저장 충돌 감지용. GET이 준 값을 PUT이 그대로 돌려보낸다. */
  readonly mtimeMs: number;
}

export interface PutFileRequest {
  readonly content: string;
  readonly baseMtimeMs: number;
}

export type PutFileResponse =
  | { readonly saved: true; readonly mtimeMs: number }
  | { readonly saved: false; readonly reason: "conflict"; readonly mtimeMs: number };

/**
 * External 세션의 상호작용 하나. 화면이 그릴 것만 담는다.
 *
 * `record` 의 `StoredInteraction` 을 그대로 흘리지 않는 이유가 둘이다. 하나는 `matchKey`·
 * `interactionSchemaVersion` 같은 내부 값이 API 계약이 되어 버리는 것이고, 다른 하나는
 * 응답 본문이 통째로 실려 목록 응답이 수십 MB 가 되는 것이다. 본문이 필요해지면 그때
 * 별도 경로를 연다.
 *
 * `method`·`url` 은 `display` 에서 온다 — 마스킹이 끝난 쪽이라 그대로 보여도 안전하다(ADR-0053).
 */
export interface SessionInteraction {
  readonly ordinal: number;
  readonly occurrence: number;
  readonly recordedAt: string;
  readonly status: "incomplete" | "complete";
  readonly method: string;
  readonly url: string;
  /** 응답 상태 코드. 미완료이거나 `fetch` 가 던진 경우 null 이다. */
  readonly responseStatus: number | null;
  /** `fetch` 자체가 실패한 상호작용인지. 자유 텍스트는 담기지 않는다(ADR-0053). */
  readonly threw: boolean;
}

/** GET /api/sessions/:path */
export interface SessionDetail {
  readonly path: string;
  readonly sessionId: string;
  readonly status: "running" | "completed" | "failed";
  readonly interactions: readonly SessionInteraction[];
}

export interface ApiError {
  readonly error: string;
}
