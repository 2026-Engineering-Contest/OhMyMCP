/**
 * 폼 → argv 계약. `parseTestCommand`(packages/cli/src/test-command.ts)의 검증 규칙과
 * 어긋나면 대시보드만 다른 제품이 된다.
 *
 * 녹화·재생은 독립 동작이 아니라 **시험 실행의 수식어**다. CLI 가 별도 명령이 아니라
 * `mcpeak test` 의 플래그로 낸 이유가 그것이고, 그래서 이 폼도 실행 폼 안에 산다.
 */

/**
 * External 세션 옵션. 셋 중 하나만 고른다.
 *
 * CLI 는 `--session` 과 `--record-session` 이 함께 오면 실행 중에 거절한다(`test-command.ts`
 * 의 "재생과 녹화 중 하나만 고르세요"). 여기서는 **유니온이라 그 상태가 아예 만들어지지
 * 않는다** — 라디오 버튼 하나가 실제 모양이기도 하다.
 */
export type SessionMode = "none" | "record" | "replay";

export interface TestForm {
  readonly suitePath: string;
  /** 실행 파일 하나만("node" 등). CLI `--command` 계약이 실행 파일 단독이라 스크립트 경로는 args 선두로 간다. */
  readonly command: string;
  readonly args: readonly string[];
  readonly sessionMode: SessionMode;
  /** 빈 문자열 = 미지정. `sessionMode` 가 `"none"` 이면 쓰지 않는다. */
  readonly sessionPath: string;
}

/**
 * 세션 모드별 CLI 플래그. `none` 은 붙일 것이 없다.
 *
 * `Readonly<Record<SessionMode, …>>` 인 이유는 `SessionMode` 에 값을 더했을 때 여기를
 * 빠뜨리면 **컴파일이 깨지게** 하기 위해서다. 빠뜨려도 도는 코드면 새 모드가 화면에서만
 * 조용히 사라진다.
 */
const SESSION_FLAG: Readonly<Record<SessionMode, string | null>> = {
  none: null,
  record: "--record-session",
  replay: "--session",
};

/** 오류 문구용 라벨(조사 포함). */
const SESSION_LABEL: Readonly<Record<SessionMode, string>> = {
  none: "",
  record: "녹화는",
  replay: "재생은",
};

/** 위반 시 한국어 메시지로 throw. UI 는 이 함수를 폼 검증에도 재사용한다. */
export function buildTestArgv(form: TestForm): readonly string[] {
  if (form.suitePath === "") {
    throw new Error("테스트 스위트를 고르세요.");
  }
  if (form.command === "") {
    throw new Error("실행 명령을 입력하세요.");
  }
  if (form.sessionMode !== "none" && form.sessionPath === "") {
    throw new Error(`${SESSION_LABEL[form.sessionMode]} 세션 파일 경로가 있어야 합니다.`);
  }

  // argv 순서를 고정한다. 같은 폼이면 항상 같은 배열(결정론).
  const argv: string[] = [form.suitePath, "--command", form.command];
  for (const arg of form.args) {
    argv.push("--arg", arg);
  }
  const flag = SESSION_FLAG[form.sessionMode];
  if (flag !== null) {
    argv.push(flag, form.sessionPath);
  }
  return argv;
}
