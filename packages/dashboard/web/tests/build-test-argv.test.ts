// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TestForm } from "../src/run/build-test-argv.js";
import { buildTestArgv } from "../src/run/build-test-argv.js";

/** 세션을 쓰지 않는 최소 입력. 각 테스트가 필요한 필드만 덮어쓴다. */
const BASE: TestForm = {
  suitePath: "examples/weather/suite.json",
  command: "node",
  args: [],
  sessionMode: "none",
  sessionPath: "",
};

describe("buildTestArgv", () => {
  /**
   * 이 작업의 안전선이다. 세션을 안 쓰는 기존 사용자의 실행이 한 글자도 바뀌면 안 된다.
   * 배열 그대로 단언하는 이유가 그것이다 — "포함한다" 로는 원소가 끼어든 것을 못 잡는다.
   */
  it("세션을 쓰지 않으면 세션 옵션이 붙기 전과 같은 argv를 만든다", () => {
    expect(buildTestArgv({ ...BASE, args: ["server.js"] })).toEqual([
      "examples/weather/suite.json",
      "--command",
      "node",
      "--arg",
      "server.js",
    ]);
  });

  it("녹화면 --record-session 이 경로와 함께 끝에 붙는다", () => {
    expect(
      buildTestArgv({ ...BASE, sessionMode: "record", sessionPath: ".mcpeak/s.db" }),
    ).toEqual(["examples/weather/suite.json", "--command", "node", "--record-session", ".mcpeak/s.db"]);
  });

  it("재생이면 --session 이 경로와 함께 끝에 붙는다", () => {
    expect(
      buildTestArgv({ ...BASE, sessionMode: "replay", sessionPath: ".mcpeak/s.db" }),
    ).toEqual(["examples/weather/suite.json", "--command", "node", "--session", ".mcpeak/s.db"]);
  });

  // CLI 는 두 플래그가 같이 오면 실행 중에 거절한다. 여기서는 유니온이라 그 조합이 만들어지지
  // 않는데, "만들어지지 않는다" 를 테스트로도 붙잡아 둔다.
  it("녹화 argv 에는 --session 이 없다", () => {
    const argv = buildTestArgv({ ...BASE, sessionMode: "record", sessionPath: "s.db" });
    expect(argv).not.toContain("--session");
  });

  it("재생 argv 에는 --record-session 이 없다", () => {
    const argv = buildTestArgv({ ...BASE, sessionMode: "replay", sessionPath: "s.db" });
    expect(argv).not.toContain("--record-session");
  });

  it("args 를 각각 --arg 로 펼친다", () => {
    expect(buildTestArgv({ ...BASE, args: ["server.js", "--port", "0"] })).toEqual([
      "examples/weather/suite.json",
      "--command",
      "node",
      "--arg",
      "server.js",
      "--arg",
      "--port",
      "--arg",
      "0",
    ]);
  });

  it("경로 없이 녹화를 고르면 막는다", () => {
    expect(() => buildTestArgv({ ...BASE, sessionMode: "record" })).toThrow(
      "녹화는 세션 파일 경로가 있어야 합니다.",
    );
  });

  it("경로 없이 재생을 고르면 막는다", () => {
    expect(() => buildTestArgv({ ...BASE, sessionMode: "replay" })).toThrow(
      "재생은 세션 파일 경로가 있어야 합니다.",
    );
  });

  it("실행 명령이 비면 막는다", () => {
    expect(() => buildTestArgv({ ...BASE, command: "" })).toThrow("실행 명령을 입력하세요.");
  });

  it("스위트 경로가 비면 막는다", () => {
    expect(() => buildTestArgv({ ...BASE, suitePath: "" })).toThrow("테스트 스위트를 고르세요.");
  });

  it("같은 폼이면 항상 같은 배열이다", () => {
    const form: TestForm = {
      ...BASE,
      args: ["server.js"],
      sessionMode: "record",
      sessionPath: "s.db",
    };
    expect(buildTestArgv(form)).toEqual(buildTestArgv(form));
  });
});
