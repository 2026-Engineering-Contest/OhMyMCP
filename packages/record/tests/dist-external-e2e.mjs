/**
 * 빌드 산출물 기준으로 `@mcpeak/record/external` 을 검증한다.
 *
 * vitest 쪽 `subpath-export.test.ts` 는 alias 때문에 **소스**를 로드한다. 그래서
 * `dist/external/index.cjs` 가 없거나 `exports` 의 require 조건이 어긋나도 초록이다.
 * 사용자가 받는 것은 dist 이므로 그쪽을 밟는 검사가 따로 필요하다.
 *
 * vitest 가 아니라 맨 node 인 이유는 CI 의 `verify` 잡이 **빌드 없이** `pnpm test` 를 돌기
 * 때문이다. 빌드가 끝난 `build` 잡에서만 의미가 있고, 그 자리는 `@mcpeak/cli` 의
 * `test:e2e` 가 이미 쓰고 있는 형태다.
 *
 * 패키지 이름으로 부르는 것이 요점이다. 상대 경로로 dist 를 직접 import 하면 `exports` 를
 * 우회해 버려서, 정작 사용자가 밟는 해석 경로를 검사하지 못한다.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** 값 세 개. 이 목록이 곧 공개 계약이라 늘어나는 것도 검사 대상이다. */
const EXPECTED = [
  "ExternalRecordReplayError",
  "createSqliteSessionStore",
  "loadSession",
  "startExternalCoordinator",
];

// ── import 조건이 ESM 산출물로 간다
//
// 표면만 보면 부족하다. `exports` 의 import 조건이 실수로 `.cjs` 를 가리켜도 Node 는 CJS 를
// 동적 import 로 받아 주고 named export 까지 내주므로, 아래 표면·타입 단언은 그대로 통과한다.
// 그래서 **해석된 경로**를 먼저 못 박는다.
const esmPath = import.meta.resolve("@mcpeak/record/external");
assert.match(
  esmPath.replaceAll("\\", "/"),
  /\/dist\/external\/index\.mjs$/,
  `import 조건이 ESM 산출물을 가리키지 않습니다: ${esmPath}`,
);
const esm = await import("@mcpeak/record/external");
assert.deepEqual(Object.keys(esm).sort(), EXPECTED, "ESM 표면이 계약과 다릅니다.");

// ── require 조건이 CJS 산출물로 간다
const cjsPath = require.resolve("@mcpeak/record/external");
assert.match(
  cjsPath.replaceAll("\\", "/"),
  /\/dist\/external\/index\.cjs$/,
  `require 조건이 CJS 산출물을 가리키지 않습니다: ${cjsPath}`,
);
const cjs = require("@mcpeak/record/external");
assert.deepEqual(Object.keys(cjs).sort(), EXPECTED, "CJS 표면이 ESM 과 다릅니다.");

// ── 두 조건이 같은 계약을 준다
for (const name of EXPECTED) {
  assert.equal(typeof esm[name], "function", `ESM ${name} 이 함수가 아닙니다.`);
  assert.equal(typeof cjs[name], "function", `CJS ${name} 이 함수가 아닙니다.`);
}

// ── 자식 bootstrap 이 산출물 안에서 해석된다
//
// 여기가 이 파일의 핵심이다. bootstrap 은 번들되지 않고 URL 로 로드되므로, 빌드 레이아웃이
// 바뀌면 Coordinator 가 가리킬 파일이 사라지고 **자식이 기동조차 못 한다.** 타입도 테스트도
// 초록인 채로 배포된 패키지만 깨지는 자리다.
for (const [label, mod] of [
  ["ESM", esm],
  ["CJS", cjs],
]) {
  const store = mod.createSqliteSessionStore();
  const handle = await mod.startExternalCoordinator({
    mode: "record",
    sessionId: `dist-${label}`,
    store,
  });
  const bootstrapUrl = (handle.childEnvironment.NODE_OPTIONS ?? "").match(/--import=(\S+)/)?.[1];
  assert.ok(bootstrapUrl, `${label}: childEnvironment 에 bootstrap 주입이 없습니다.`);
  assert.ok(
    existsSync(fileURLToPath(bootstrapUrl)),
    `${label}: bootstrap 이 가리키는 파일이 없습니다 — ${bootstrapUrl}`,
  );
  await handle.finish("failed");
  store.close();
}

console.log("dist-external-e2e: 통과 (ESM · CJS 두 조건 + bootstrap 해석)");
