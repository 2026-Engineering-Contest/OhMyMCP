/**
 * 크기 상한 — **자식(`.mjs`)과 부모(`.ts`)가 같은 값을 봐야 하므로 여기 한 곳에 둔다.**
 *
 * 한때 `protocol.ts` 와 `child/coordinator-client.mjs` 가 각자 `2 * 1024 * 1024` 를 적어
 * 두고 있었다. 한쪽만 고치면 자식은 보내고 부모는 거절하는 상태가 되는데, 그때 나오는
 * 오류는 413 뿐이라 원인이 상한 불일치라는 것을 알 수 없다.
 */

/** 요청·응답 body 하나의 상한. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

/**
 * Coordinator 요청·응답 payload 상한.
 *
 * **HTTP body 상한에서 출발한다.** `begin` payload 는 body 를 `display` 에 한 번만 싣는다
 * — 매칭 재료(`match`)는 자식 프로세스 밖으로 나가지 않는다(ADR-0053). 한때는 `match` 와
 * `display` 에 같은 body 를 두 번 실어 2배로 잡았는데, 그 필드가 없어진 뒤에도 배수를
 * 그대로 두면 상한이 지금 실제로 오가는 payload 보다 훨씬 헐거워져 "이 상한이 실제로 무엇을
 * 재는가" 라는 원래 취지가 깨진다. 여기에 method·URL·헤더·matchKey 같은 메타데이터 여유를
 * 128 KiB 더한다.
 *
 * 이 관계를 무시하고 고정 상수로 박아 두면, HTTP 상한을 통과한 body 가 Coordinator 에서
 * `PAYLOAD_TOO_LARGE` 로 죽을 수 있다. 사용자 입장에서는 "지원한다고 한 크기인데 안 된다" 가
 * 된다.
 */
export const MAX_COORDINATOR_PAYLOAD_BYTES = MAX_HTTP_BODY_BYTES + 128 * 1024;
