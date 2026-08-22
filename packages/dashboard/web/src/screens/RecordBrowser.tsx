import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  FileEntry,
  SessionDetail,
  StartRunRequest,
  StartRunResponse,
} from "../../../src/api-types.js";
import { apiGet, apiSend } from "../api.js";
import type { CommandMethod } from "../generate/steps/StepServer.js";
import { StepServer, splitCommand } from "../generate/steps/StepServer.js";
import { buildTestArgv } from "../run/build-test-argv.js";

/**
 * Record 화면. 옛 Cassettes 화면(UI 설계 §5-4)과 같은 좌측 목록(300px) + 우측 상세다.
 *
 * 카세트와 다른 점이 하나 있다. 카세트는 JSON 이라 textarea 로 고칠 수 있었지만 **세션은
 * SQLite 바이너리라 편집 affordance 가 없다.** 그 자리는 재생 실행이 대신한다.
 */
export function RecordBrowser({ path }: { readonly path: string | null }): JSX.Element {
  // 상세에서 삭제가 일어나면 목록을 다시 부르기 위한 신호.
  const [listVersion, setListVersion] = useState(0);

  return (
    <section className="flex min-w-0 gap-6">
      <SessionList selected={path} version={listVersion} />
      <div className="min-w-0 flex-1">
        {path === null ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">왼쪽 목록에서 세션을 선택하세요.</p>
            <p className="text-sm text-ink-muted">
              세션이 없다면 홈에서 스위트를 <code className="font-mono text-xs">--record-session</code>{" "}
              으로 실행해 먼저 녹화하세요.
            </p>
          </div>
        ) : (
          <SessionDetailView
            // 경로 전환 시 상세 상태를 리셋한다. 옛 CassetteDetail 의 회귀 수정 계승.
            key={path}
            path={path}
            onDeleted={() => {
              setListVersion((version) => version + 1);
              window.location.hash = "#/record";
            }}
          />
        )}
      </div>
    </section>
  );
}

function SessionList({
  selected,
  version,
}: {
  readonly selected: string | null;
  readonly version: number;
}): JSX.Element {
  const [sessions, setSessions] = useState<readonly FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version은 상세의 삭제 후 목록 재조회를 트리거하는 신호다(본문에서 값은 안 쓴다)
  useEffect(() => {
    setError(null);
    apiGet<FileEntry[]>("/api/sessions")
      .then(setSessions)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [version]);

  return (
    <aside className="w-[300px] shrink-0">
      <h1 className="mb-3 text-xl font-semibold text-ink">세션</h1>
      {error !== null && (
        <p className="text-sm" style={{ color: "var(--status-failed-fg)" }}>
          {error}
        </p>
      )}
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {sessions === null && <li className="px-3 py-2 text-sm text-ink-muted">불러오는 중...</li>}
        {sessions !== null && sessions.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-muted">녹화된 세션이 없습니다.</li>
        )}
        {sessions?.map((session) => (
          <li key={session.path} className="border-b border-line-subtle last:border-b-0">
            <a
              aria-current={session.path === selected ? "true" : undefined}
              className={`block px-3 py-2 font-mono text-xs break-all hover:text-accent ${
                session.path === selected ? "bg-accent-soft text-accent" : "text-ink"
              }`}
              href={`#/record/${encodeURIComponent(session.path)}`}
            >
              {session.path}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function SessionDetailView({
  path,
  onDeleted,
}: {
  readonly path: string;
  readonly onDeleted: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [suites, setSuites] = useState<readonly FileEntry[]>([]);
  const [suitePath, setSuitePath] = useState("");
  const [method, setMethod] = useState<CommandMethod>("node");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState<readonly string[]>([]);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setActionError(null);
    apiGet<SessionDetail>(`/api/sessions/${encodeURIComponent(path)}`)
      .then(setDetail)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    apiGet<FileEntry[]>("/api/suites")
      .then((entries) => {
        setSuites(entries);
        setSuitePath((current) => (current === "" ? (entries[0]?.path ?? "") : current));
      })
      .catch(() => setSuites([]));
  }, [path]);

  async function replay(): Promise<void> {
    const { command, leadingArgs } = splitCommand(method, target);
    let argv: readonly string[];
    try {
      argv = buildTestArgv({
        suitePath,
        command,
        args: [...leadingArgs, ...args],
        sessionMode: "replay",
        sessionPath: path,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const response = await apiSend<StartRunResponse>("POST", "/api/runs", {
        flow: "test",
        argv: [...argv],
      } satisfies StartRunRequest);
      window.location.hash = `#/runs/${encodeURIComponent(response.runId)}`;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await apiSend("DELETE", `/api/sessions/${encodeURIComponent(path)}`);
      onDeleted();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <p className="text-sm" style={{ color: "var(--status-failed-fg)" }}>
        {loadError}
      </p>
    );
  }
  if (detail === null) {
    return <p className="text-sm text-ink-muted">불러오는 중...</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="font-mono text-sm break-all text-ink">{detail.path}</p>
        <p className="mt-1 text-xs text-ink-muted">
          상태 {detail.status} · 외부 호출 {detail.interactions.length}건
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
          녹화된 외부 호출
        </h2>
        {detail.interactions.length === 0 ? (
          <div className="space-y-1 px-4 py-3">
            <p className="text-sm text-ink-muted">이 세션에는 녹화된 외부 호출이 없습니다.</p>
            <p className="text-xs text-ink-muted">
              MCPeak은 서버가 <code className="font-mono">globalThis.fetch</code>로 부른 것만 잡습니다.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line-subtle">
            {detail.interactions.map((interaction) => (
              <li
                key={`${interaction.ordinal}-${interaction.occurrence}`}
                className="flex items-baseline gap-3 px-4 py-2"
              >
                <span className="w-14 shrink-0 font-mono text-xs font-semibold text-ink">
                  {interaction.method}
                </span>
                <span className="min-w-0 flex-1 font-mono text-xs break-all text-ink-muted">
                  {interaction.url}
                </span>
                {interaction.occurrence > 0 && (
                  <span className="shrink-0 text-xs text-ink-muted">#{interaction.occurrence}</span>
                )}
                <span className="shrink-0 font-mono text-xs text-ink">
                  {interaction.threw
                    ? "실패"
                    : (interaction.responseStatus ?? (interaction.status === "incomplete" ? "미완료" : "—"))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-line bg-surface p-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">이 세션으로 재생</h2>
          <p className="mt-1 text-xs text-ink-muted">
            서버는 실제로 실행되지만, 외부 호출은 녹화본으로 답합니다.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink">테스트 스위트</span>
          <select
            className="w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-ink"
            value={suitePath}
            onChange={(event) => setSuitePath(event.target.value)}
          >
            {suites.length === 0 && <option value="">스위트가 없습니다</option>}
            {suites.map((suite) => (
              <option key={suite.path} value={suite.path}>
                {suite.path}
              </option>
            ))}
          </select>
        </label>
        <StepServer
          idPrefix="record-replay"
          method={method}
          target={target}
          args={args}
          recentCommands={[]}
          onMethodChange={setMethod}
          onTargetChange={setTarget}
          onArgsChange={setArgs}
        />
        {actionError !== null && (
          <p className="text-sm" style={{ color: "var(--status-failed-fg)" }}>
            {actionError}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={busy || splitCommand(method, target).command === "" || suitePath === ""}
            onClick={() => void replay()}
          >
            재생 실행
          </button>
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void remove()}
          >
            세션 삭제
          </button>
        </div>
      </div>
    </div>
  );
}
