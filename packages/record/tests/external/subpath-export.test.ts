import { createRequire } from "node:module";
import {
  createSqliteSessionStore,
  ExternalRecordReplayError,
  startExternalCoordinator,
} from "@mcpeak/record/external";
import { describe, expect, it } from "vitest";

/**
 * `@mcpeak/record/external` subpath 가 **네 곳에서 동시에** 성립하는지 본다.
 *
 * `packages/record/package.json` exports / `tsdown.config.mjs` entry /
 * `tsconfig.base.json` paths / `vitest.config.ts` alias — 하나라도 빠지면 "타입체크는
 * 초록인데 테스트는 빨강" 이거나 그 반대가 난다. 각 설정 파일의 주석이 그 사고를 기록하고
 * 있고, 이 파일은 그 네 개를 한 번에 밟는다.
 *
 * 이 파일이 bare specifier 로 import 하는 것 자체가 alias 검사다. 아래 단언은 나머지 셋을 본다.
 *
 * **다만 여기서는 dist 를 볼 수 없다.** 위의 import 는 alias 를 타 소스로 해석되고, `exports`
 * 는 문자열로만 확인한다. 그래서 `dist/external/index.cjs` 가 없거나 require 조건이 어긋나도
 * 이 파일은 초록이다. 그쪽은 `tests/dist-external-e2e.mjs` 가 빌드 뒤에 실제로 밟는다
 * (CI 의 `build` 잡, `pnpm --filter @mcpeak/record test:e2e`).
 */

const require = createRequire(import.meta.url);

describe("@mcpeak/record/external subpath", () => {
  it("alias 를 통해 값이 실제로 실려 온다", () => {
    expect(typeof startExternalCoordinator).toBe("function");
    expect(typeof createSqliteSessionStore).toBe("function");
    expect(typeof ExternalRecordReplayError).toBe("function");
  });

  it("package.json 이 ./external 을 내보내고 파일이 실재한다", () => {
    const manifest = require("../../package.json") as {
      exports: Record<string, { import: { types: string; default: string } }>;
    };
    const entry = manifest.exports["./external"];

    expect(entry).toBeDefined();
    // exports 가 가리키는 경로와 tsdown 이 실제로 내는 경로가 어긋나면 설치한 사용자만 깨진다.
    expect(entry?.import.default).toBe("./dist/external/index.mjs");
    expect(entry?.import.types).toBe("./dist/external/index.d.mts");
  });

  it("공개 표면을 최소로 유지한다 — 늘리는 것은 쉽고 줄이는 것은 breaking 이다", async () => {
    const surface = Object.keys(await import("@mcpeak/record/external")).sort();

    expect(surface).toEqual([
      "ExternalRecordReplayError",
      "createSqliteSessionStore",
      // 대시보드가 프로젝트를 훑으며 "이게 세션인가" 를 묻는 판별기다(`loadCassette` 자리).
      "loadSession",
      "startExternalCoordinator",
    ]);
  });

  it("자식 전용 모듈과 Store 내부는 내보내지 않는다", async () => {
    const surface = Object.keys(await import("@mcpeak/record/external"));

    // 자식은 별도 프로세스에서만 돈다. 호출자는 경로조차 알 필요가 없다.
    expect(surface).not.toContain("installFetchAdapter");
    expect(surface).not.toContain("createCoordinatorClient");
    // 스키마 세부가 새면 마이그레이션이 Store 안에서 끝나지 못한다.
    expect(surface).not.toContain("SQLITE_STORE_VERSION");
    // 테스트 하네스용이다. 공개하면 "인메모리로 녹화하면 어디 남나요" 가 따라온다.
    expect(surface).not.toContain("createMemorySessionStore");
  });

  it("legacy 진입점을 끌어오지 않는다 (ADR-0051)", async () => {
    const surface = Object.keys(await import("@mcpeak/record/external"));

    expect(surface).not.toContain("createCassetteClient");
    expect(surface).not.toContain("saveCassette");
    expect(surface).not.toContain("loadCassette");
  });
});
