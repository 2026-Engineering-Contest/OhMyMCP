import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.js";

vi.mock("@mcpeak/core", async () => import("../../core/src/index.js"));
vi.mock("@mcpeak/runner", async () => import("../../runner/src/index.js"));

/**
 * P9 의 실질 목표를 본다 — **별개 실행에서 Record → Replay 가 성립하는가.**
 *
 * 단계 B 의 수직 e2e 는 한 프로세스 안에서 Coordinator 를 두 번 열어 확인했다. 여기서는
 * `test` 를 두 번 돌린다. 그 사이에 남는 것은 세션 파일 하나뿐이고, 두 번째 실행은 첫 번째가
 * 무엇을 했는지 파일로만 안다.
 *
 * 판정은 **origin 호출 카운터**다. 재생이 실제로 됐다면 두 번째 실행에서 카운터가 움직이지
 * 않는다. 결과만 같은지 보면 서버가 외부를 다시 불러 같은 답을 받은 경우와 구분되지 않는다.
 *
 * 빌드 산출물이 아니라 `../src/index.js` 의 `run` 을 부른다. dist CLI 쪽 검증은 `build` 잡의
 * `dist-cli-e2e.mjs` 가 따로 한다.
 */

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const server = join(here, "fixtures/external-fetch-server.mjs");
/** 외부 요청을 `node:http` 로 내는 서버 — ADR-0057 이 정한 지원 범위의 바깥이다. */
const httpServer = join(here, "fixtures/external-http-server.mjs");
const suite = join(here, "fixtures/external-fetch.suite.json");
const threeSuite = join(here, "fixtures/external-fetch-three.suite.json");
const twoSuite = join(here, "fixtures/external-fetch-two.suite.json");

const directories: string[] = [];
const servers: Server[] = [];

// 정리는 훅에서 한다. 본문 마지막 줄에 두면 앞선 단언이 실패했을 때 도달하지 않아, 열린
// 서버 핸들이 남고 다음 테스트가 그 영향을 받는다. 첫 실패가 원인인데 두 번째 증상만 보인다.
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((instance) => new Promise<void>((done) => instance.close(() => done()))),
  );
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** 호출 횟수를 세는 origin. 카운터는 호출자가 읽는다. */
const startOrigin = async (): Promise<{
  readonly url: (path: string) => string;
  readonly calls: () => number;
}> => {
  let calls = 0;
  const origin = createServer((request, response) => {
    calls += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ city: url.searchParams.get("city"), weather: "sunny" }));
  });
  servers.push(origin);
  await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
  const { port } = origin.address() as { port: number };
  return { url: (path) => `http://127.0.0.1:${port}${path}`, calls: () => calls };
};

/** 테스트별 새 SQLite 세션 경로를 만들고, 훅에서 지울 디렉터리 목록에 등록한다. */
const newSessionPath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "mcpeak-cli-session-"));
  directories.push(directory);
  return join(directory, "session.db");
};

/**
 * origin 을 `--arg` 로 넘긴다. 자식은 부모 env 를 상속하지 않으므로(SDK 의 spawn env 가
 * `{...getDefaultEnvironment(), ...options.env}` 다) 환경 변수로는 전달되지 않는다.
 */
const runWith = (
  serverPath: string,
  suitePath: string,
  extra: readonly string[],
  originUrl: string,
): Promise<number> =>
  run([
    "test",
    suitePath,
    "--command",
    process.execPath,
    "--arg",
    serverPath,
    "--arg",
    originUrl,
    ...extra,
  ]);

/** 기본 External HTTP fixture 조합으로 `mcpeak test` 를 실행한다. */
const runTest = (extra: readonly string[], originUrl: string): Promise<number> =>
  runWith(server, suite, extra, originUrl);

/**
 * `run` 은 의존성을 받지 않고 `process.stderr` 로 직접 쓴다(`src/index.ts`). 종료 경고 문구를
 * 보려면 그 자리에서 가로채는 수밖에 없다. 복원은 `finally` 에서 한다 — 단언이 실패해도
 * 다음 테스트가 벙어리 stderr 를 물려받지 않는다.
 */
const captureStderr = async (
  body: () => Promise<number>,
): Promise<{ readonly exitCode: number; readonly stderr: string }> => {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write);
  try {
    return { exitCode: await body(), stderr };
  } finally {
    spy.mockRestore();
  }
};

describe("mcpeak test 의 External 세션", () => {
  it("녹화한 뒤 다른 실행에서 재생하면 외부 API 를 다시 부르지 않는다", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    const recorded = await runTest(["--record-session", sessionPath], origin.url("/weather"));
    expect(recorded).toBe(0);
    expect(origin.calls()).toBe(1);

    // 두 번째 실행은 세션 파일 말고는 첫 실행과 아무것도 공유하지 않는다.
    const replayed = await runTest(["--session", sessionPath], origin.url("/weather"));

    expect(replayed).toBe(0);
    expect(origin.calls()).toBe(1);
  }, 30_000);

  it("녹화에 없는 호출을 만나면 네트워크로 새지 않고 실패한다", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    // 다른 경로로 녹화한다 — 재생 때의 요청과 URL 이 달라 matchKey 가 어긋난다.
    const recorded = await runTest(["--record-session", sessionPath], origin.url("/recorded"));
    // 녹화가 성공했고 origin 을 실제로 한 번 불렀다는 것을 먼저 고정한다. 이게 없으면 녹화가
    // 어떤 이유로든 실패했을 때 카운터가 0 인 채로 아래 단언이 전부 통과해, 테스트가 아무것도
    // 증명하지 못한 채 초록이 된다.
    expect(recorded).toBe(0);
    expect(origin.calls()).toBe(1);

    const replayed = await runTest(["--session", sessionPath], origin.url("/other"));

    expect(replayed).not.toBe(0);
    // 실패하더라도 외부로 나가지 않는 것이 Replay 의 존재 이유다.
    expect(origin.calls()).toBe(1);
  }, 30_000);

  /**
   * #259 -- record 의 REPLAY_MISS 진단이 MCP 오류 채널을 타면 runner 가 서버 텍스트로
   * 취급해 개행을 escape sequence 로 바꾸고 200자에서 자른다. 그 채널을 타지 않는
   * renderReplayMissDiagnostics 블록이 stderr 에 그대로 실리는지를 실제 자식 프로세스로
   * 확인한다. renderReplayMissDiagnostics 단위 테스트가 배치를, 이 테스트가 그 값이 실제
   * 세션에서 CLI 출력까지 닿는 배선을 본다.
   */
  it("녹화에 없는 호출을 만나면 stderr 에 잘리지 않고 개행이 살아있는 진단을 남긴다(#259)", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    const recorded = await runTest(["--record-session", sessionPath], origin.url("/recorded"));
    expect(recorded).toBe(0);
    expect(origin.calls()).toBe(1);

    const { exitCode, stderr } = await captureStderr(() =>
      runTest(["--session", sessionPath], origin.url("/other")),
    );

    expect(exitCode).not.toBe(0);
    expect(origin.calls()).toBe(1);

    expect(stderr).toContain("External 진단: 재생 원본에서 찾지 못한 호출 1건");
    // `/other` 자체는 안 보인다 — ADR-0053 이 표시 URL의 pathname을 지운다. 그래도 진단이
    // 통째로 사라진 게 아니라 host·query·matchKey 로 식별할 수 있다는 것을 이 세 줄이 본다.
    expect(stderr).toContain("<redacted>");
    expect(stderr).toContain("city=seoul");
    expect(stderr).toContain("occurrence 0 · matchKey");
    // 경로가 지워졌다는 것을 직접 본다. 위 세 줄만으로는 진단이 redacted URL 과 원본 경로를
    // **함께** 찍어도 통과한다 — 그러면 이 PR 이 막으려던 유출이 진단으로 되살아난다.
    expect(stderr).not.toContain("/other");
    // MCP 오류 채널의 이스케이프(개행 escape sequence 변환)를 겪지 않았다는 증거다.
    const backslashUEscape = `${String.fromCharCode(92)}u000a`;
    expect(stderr).not.toContain(backslashUEscape);
    // 200자 절단(runner 의 MAX_VALUE_STRING_CHARS)에 걸리지 않아 해결 안내가 끝까지 남는다.
    expect(stderr).toContain(
      "녹화를 다시 하거나, 요청이 실행마다 달라지는 값을 담고 있는지 확인하세요.",
    );
  }, 30_000);
});

/**
 * ADR-0057 의 경고가 실제로 사용자 눈에 닿는지 본다.
 *
 * 앞의 describe 는 **범위 안**에서 재생이 성립하는 것을 본다. 여기는 **범위 밖**이다 — 서버가
 * `node:http` 로 부르면 어댑터가 그것을 보지 못하고, 녹화는 0건이 되며 재생은 실제 네트워크로
 * 나간다. 그 자체는 알려진 한계이고 이 테스트가 고치는 것이 아니다. 고정하는 것은 **그때
 * 도구가 침묵하지 않는다** 는 것이다([#258](https://github.com/2026-Engineering-Contest/MCPeak/issues/258)).
 *
 * 판정에 origin 카운터를 함께 쓴다. 문구만 보면 "서버가 아예 안 떠서 0건" 인 경우와 구분되지
 * 않아, 경고가 맞게 나왔는지 테스트가 증명하지 못한다.
 */
describe("mcpeak test 의 External 세션 — 지원 범위 밖 경고", () => {
  it("범위 밖 서버를 녹화하면 실제 호출은 나가고 0건 녹화를 알린다", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    const { exitCode, stderr } = await captureStderr(() =>
      runWith(httpServer, suite, ["--record-session", sessionPath], origin.url("/weather")),
    );

    // 스위트 자체는 통과한다. 종료 코드로는 아무 문제가 없어 보이는 것이 이 사고의 핵심이다.
    expect(exitCode).toBe(0);
    // 실제로 밖으로 나갔다. 어댑터가 보지 못했을 뿐이다.
    expect(origin.calls()).toBe(1);
    expect(stderr).toContain("외부 호출이 하나도 녹화되지 않았습니다");
    expect(stderr).toContain("globalThis.fetch");
  }, 30_000);

  it("빈 세션을 재생하면 네트워크로 나가고, 원본이 비었다고 알린다", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    const recorded = await runWith(
      httpServer,
      suite,
      ["--record-session", sessionPath],
      origin.url("/weather"),
    );
    expect(recorded).toBe(0);
    expect(origin.calls()).toBe(1);

    const { exitCode, stderr } = await captureStderr(() =>
      runWith(httpServer, suite, ["--session", sessionPath], origin.url("/weather")),
    );

    expect(exitCode).toBe(0);
    // 재생인데 카운터가 또 올랐다 — 이 줄이 #258 그 자체다.
    expect(origin.calls()).toBe(2);
    expect(stderr).toContain("녹화된 외부 호출이 0건입니다");
    expect(stderr).toContain("globalThis.fetch");
    // 원본이 빈 것과 원본을 못 쓴 것은 사용자가 볼 곳이 다르다. 뒤엣것 문구가 나오면 안 된다.
    expect(stderr).not.toContain("하나도 재생되지 않았습니다");
  }, 60_000);

  it("일부만 재생되면 전체와 미재생 개수를 함께 알린다", async () => {
    const origin = await startOrigin();
    const sessionPath = await newSessionPath();

    // 3건 녹화 — 범위 안(`fetch`) 서버다. 이쪽은 경고가 나오면 안 된다.
    const recorded = await captureStderr(() =>
      runWith(server, threeSuite, ["--record-session", sessionPath], origin.url("/weather")),
    );
    expect(recorded.exitCode).toBe(0);
    expect(origin.calls()).toBe(3);
    expect(recorded.stderr).not.toContain("globalThis.fetch");

    // 2건짜리 스위트로 재생한다 — 녹화된 3건 중 1건이 남는다.
    const { exitCode, stderr } = await captureStderr(() =>
      runWith(server, twoSuite, ["--session", sessionPath], origin.url("/weather")),
    );

    expect(exitCode).toBe(0);
    // 재생이 실제로 일어났으므로 카운터는 그대로다.
    expect(origin.calls()).toBe(3);
    expect(stderr).toContain("녹화된 외부 호출 3건 중 1건이 이번 실행에서 재생되지 않았습니다");
    expect(stderr).not.toContain("하나도 재생되지 않았습니다");
  }, 60_000);
});

/**
 * #260 — 없는 경로를 `--session` 에 주었을 때.
 *
 * 판정의 핵심은 문구가 아니라 **파일이 생기지 않는다** 는 것이다. `node:sqlite` 의
 * DatabaseSync 는 없는 경로를 만들어 버리므로, Store 를 연 뒤에 판정하면 오타 한 번에 빈 DB 가
 * 디스크에 남는다. 그러면 두 번째 실행부터 "파일이 없다" 가 거짓이 되어 진단이 또 어긋난다.
 */
describe("mcpeak test 의 External 세션 — 없는 세션 파일", () => {
  it("경로를 보여주고 실패하며, 그 경로에 파일을 만들지 않는다", async () => {
    const origin = await startOrigin();
    const directory = await mkdtemp(join(tmpdir(), "mcpeak-cli-missing-"));
    directories.push(directory);
    const missing = join(directory, "없는세션.db");

    const { exitCode, stderr } = await captureStderr(() =>
      runTest(["--session", missing], origin.url("/weather")),
    );

    expect(exitCode).not.toBe(0);
    // 사용자가 아는 식별자는 경로다. 내부 세션 id 가 아니라 이것이 보여야 한다.
    expect(stderr).toContain(missing);
    expect(stderr).toContain("세션 파일을 찾을 수 없습니다");
    expect(stderr).not.toContain("default");
    // 재생은 읽기다 — 쓰기 권한 안내가 붙으면 사용자를 엉뚱한 곳으로 보낸다.
    expect(stderr).not.toContain("쓰기 권한");
    // 이것이 이 수정의 핵심 증거다.
    expect(existsSync(missing)).toBe(false);
    // 서버를 띄우기 전에 멈춘다.
    expect(origin.calls()).toBe(0);
  }, 30_000);
});
