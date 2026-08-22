import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  FileEntry,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from "../../../src/api-types.js";
import { apiGet, apiSend } from "../api.js";
import { FlowChip } from "../components/FlowChip.js";
import { StatusBadge } from "../components/StatusBadge.js";
import type { CommandMethod } from "../generate/steps/StepServer.js";
import { StepServer, splitCommand } from "../generate/steps/StepServer.js";
import type { SessionMode } from "../run/build-test-argv.js";
import { buildTestArgv } from "../run/build-test-argv.js";

/** 라디오 표시 문구. 순서가 곧 화면 순서다. */
const SESSION_CHOICES: readonly (readonly [SessionMode, string])[] = [
  ["none", "안 씀"],
  ["record", "녹화"],
  ["replay", "재생"],
];

/**
 * Home(UI 설계 §5-1). 2열 카드: 좌측 테스트 스위트(GET /api/suites), 우측 최근 실행
 * (GET /api/runs). 실행 클릭은 서버 명령 입력 폼을 열고
 * `POST /api/runs {flow:"test", argv}` 하고 `#/runs/:id`로 이동한다(구현계획 §5 U2).
 *
 * 입력은 generate 마법사와 같은 `StepServer`를 쓴다. 한 칸에 명령 전체를 받아 공백으로
 * 쪼개던 것이 공백 든 경로를 가진 사용자의 실행을 통째로 막고 있었다(#223). CLI
 * `--command`가 실행 파일 하나만 받는 계약이라, 분해는 `splitCommand`가 한 벌로 한다.
 */
export function Home(): JSX.Element {
  const [suites, setSuites] = useState<readonly FileEntry[] | null>(null);
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [promptFor, setPromptFor] = useState<string | null>(null);
  // generate 마법사와 같은 기본값("node"). custom 은 공백으로 쪼개므로 기본이 되면
  // 고치려던 문제가 그대로 남는다.
  const [method, setMethod] = useState<CommandMethod>("node");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState<readonly string[]>([]);
  const [sessionMode, setSessionMode] = useState<SessionMode>("none");
  const [sessionPath, setSessionPath] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    apiGet<FileEntry[]>("/api/suites")
      .then(setSuites)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    apiGet<RunSummary[]>("/api/runs")
      .then(setRuns)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  function openPrompt(suitePath: string): void {
    setPromptFor(suitePath);
    setMethod("node");
    setTarget("");
    setArgs([]);
    setSessionMode("none");
    setSessionPath("");
    setStartError(null);
  }

  async function startRun(suitePath: string): Promise<void> {
    const { command, leadingArgs } = splitCommand(method, target);
    if (command === "") {
      return;
    }
    // 폼 검증은 argv 조립과 같은 함수가 한다. 화면이 따로 판정하면 CLI 규칙과 갈라진다.
    let argv: readonly string[];
    try {
      argv = buildTestArgv({
        suitePath,
        command,
        args: [...leadingArgs, ...args],
        sessionMode,
        sessionPath: sessionPath.trim(),
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const response = await apiSend<StartRunResponse>("POST", "/api/runs", {
        flow: "test",
        argv: [...argv],
      } satisfies StartRunRequest);
      window.location.hash = `#/runs/${encodeURIComponent(response.runId)}`;
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">홈</h1>
        <p className="mt-1 text-sm text-ink-muted">
          현재 프로젝트 아래에서 찾은 테스트 스위트로 바로 실행을 시작합니다.
        </p>
      </div>

      {loadError !== null && (
        <p className="text-sm" style={{ color: "var(--status-failed-fg)" }}>
          {loadError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            테스트 스위트
          </h2>
          <ul className="divide-y divide-line-subtle">
            {suites === null && (
              <li className="px-4 py-3 text-sm text-ink-muted">불러오는 중...</li>
            )}
            {suites !== null && suites.length === 0 && (
              <li className="px-4 py-3 text-sm text-ink-muted">스위트가 없습니다.</li>
            )}
            {suites?.map((suite) => (
              <li key={suite.path} className="space-y-2 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-ink">{suite.path}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded bg-accent px-3 py-1 text-xs font-medium text-white"
                    onClick={() => openPrompt(suite.path)}
                  >
                    실행
                  </button>
                </div>
                {promptFor === suite.path && (
                  <form
                    className="space-y-4 rounded-md border border-line bg-canvas p-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void startRun(suite.path);
                    }}
                  >
                    <StepServer
                      idPrefix="home-run"
                      method={method}
                      target={target}
                      args={args}
                      recentCommands={[]}
                      onMethodChange={setMethod}
                      onTargetChange={setTarget}
                      onArgsChange={setArgs}
                    />
                    <fieldset className="space-y-2">
                      <legend className="text-xs font-medium text-ink">External 세션</legend>
                      <p className="text-xs text-ink-muted">
                        서버 밖으로 나가는 호출(HTTP 등)을 녹화하거나, 녹화본으로 재생합니다.
                      </p>
                      <div className="flex gap-4">
                        {SESSION_CHOICES.map(([value, label]) => (
                          <label
                            key={value}
                            className="flex items-center gap-1.5 text-xs text-ink"
                          >
                            <input
                              type="radio"
                              name="home-run-session"
                              value={value}
                              checked={sessionMode === value}
                              onChange={() => setSessionMode(value)}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {sessionMode !== "none" && (
                        <input
                          type="text"
                          className="w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
                          placeholder={
                            sessionMode === "record"
                              ? "녹화본을 저장할 경로 (예: .mcpeak/session.db)"
                              : "재생할 녹화본 경로 (예: .mcpeak/session.db)"
                          }
                          value={sessionPath}
                          onChange={(event) => setSessionPath(event.target.value)}
                        />
                      )}
                    </fieldset>
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        disabled={starting || splitCommand(method, target).command === ""}
                      >
                        실행 시작
                      </button>
                      <button
                        type="button"
                        className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted"
                        onClick={() => setPromptFor(null)}
                      >
                        취소
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {startError !== null && (
            <p className="px-4 py-3 text-sm" style={{ color: "var(--status-failed-fg)" }}>
              {startError}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            최근 실행
          </h2>
          <ul className="divide-y divide-line-subtle">
            {runs === null && <li className="px-4 py-3 text-sm text-ink-muted">불러오는 중...</li>}
            {runs !== null && runs.length === 0 && (
              <li className="px-4 py-3 text-sm text-ink-muted">아직 실행이 없습니다.</li>
            )}
            {runs?.map((run) => (
              <li key={run.runId}>
                <a
                  className="flex items-center gap-3 px-4 py-3 text-ink hover:bg-line-subtle"
                  href={`#/runs/${encodeURIComponent(run.runId)}`}
                >
                  <FlowChip flow={run.flow} />
                  <span className="flex-1 font-mono text-xs">{run.runId}</span>
                  <StatusBadge status={run.status} exitCode={run.exitCode} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
