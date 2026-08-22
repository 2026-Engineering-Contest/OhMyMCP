import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectStdio } from "@mcpeak/core";
import { afterEach, describe, expect, it } from "vitest";
import { startExternalCoordinator } from "../../src/external/coordinator.js";
import { createMemorySessionStore } from "../../src/external/session-store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
});

describe("external Record/Replay vertical", () => {
  it("실제 MCP 서버를 다시 실행하면서 Replay에서는 origin을 한 번도 호출하지 않는다", async () => {
    let originCalls = 0;
    const origin = createServer((request, response) => {
      originCalls += 1;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.writeHead(200, {
        "content-type": "application/json",
        "x-origin-fixture": "yes",
      });
      response.end(JSON.stringify({ city: url.searchParams.get("city"), weather: "sunny" }));
    });
    await new Promise<void>((resolve, reject) => {
      origin.once("error", reject);
      origin.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          origin.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    );
    const address = origin.address();
    if (address === null || typeof address === "string") throw new Error("origin address missing");
    const originUrl = `http://127.0.0.1:${address.port}/weather`;
    const fixture = fileURLToPath(
      new URL("../fixtures/external/fetch-mcp-server.mjs", import.meta.url),
    );
    const store = createMemorySessionStore();

    const record = await startExternalCoordinator({ mode: "record", sessionId: "vertical", store });
    cleanups.push(() => record.finish("failed").then(() => undefined));
    const recordConnection = await connectStdio({
      command: process.execPath,
      args: [fixture],
      env: { ...record.childEnvironment, MCPEAK_TEST_ORIGIN_URL: originUrl },
    });
    const recorded = await recordConnection.client.callTool("fetch_weather", { city: "seoul" });
    await recordConnection.close();
    await record.finish("completed");
    expect(originCalls).toBe(1);

    const replay = await startExternalCoordinator({
      mode: "replay",
      sourceSessionId: "vertical",
      store,
    });
    cleanups.push(() => replay.finish("failed").then(() => undefined));
    const replayConnection = await connectStdio({
      command: process.execPath,
      args: [fixture],
      env: { ...replay.childEnvironment, MCPEAK_TEST_ORIGIN_URL: originUrl },
    });
    const replayed = await replayConnection.client.callTool("fetch_weather", { city: "seoul" });

    // status·header·body 는 기록과 동일하다. `url` 만 다르다 — 저장된 응답의 pathname 은
    // ADR-0053 이 지운다. 그래서 여기서만 recorded 와 replayed 가 벌어지고, 그 벌어짐이
    // 정확히 pathname 자리인지를 아래에서 직접 확인한다.
    const recordedText = (
      recorded.content as readonly { readonly type: string; readonly text: string }[]
    )[0]?.text;
    const replayText = (
      replayed.content as readonly { readonly type: string; readonly text: string }[]
    )[0]?.text;
    const recordedBody = JSON.parse(recordedText ?? "null");
    const replayBody = JSON.parse(replayText ?? "null");

    expect(recordedBody).toEqual({
      status: 200,
      url: `${originUrl}?city=seoul&requestId=fixture-value`,
      header: "yes",
      body: { city: "seoul", weather: "sunny" },
    });
    expect(replayBody).toEqual({
      status: 200,
      url: `http://127.0.0.1:${address.port}/<redacted>?city=seoul&requestId=fixture-value`,
      header: "yes",
      body: { city: "seoul", weather: "sunny" },
    });
    expect(originCalls).toBe(1);
    // miss 가 네트워크로 새지 않는 것이 Replay 의 존재 이유다. 그런데 `toThrow()` 만으로는
    // 그것을 증명하지 못한다 — 자식이 크래시해도 호출은 실패하고 카운터도 그대로다.
    // 그래서 실패의 정체까지 본다. 이 문장이 부모의 REPLAY_MISS 에서 출발해 Coordinator 와
    // 자식 어댑터, JSON-RPC 를 지나 호출자까지 살아 돌아왔다면 경로가 lookup 에서 끊긴 것이다.
    //
    // `cause` 를 보는 이유: `core` 는 최상위 message 를 안정된 카탈로그 문장으로 고정하고
    // (`OPERATION_FAILED`), 서버가 준 원문은 `cause` 에 남긴다. 진단은 그쪽에 있다.
    const missed = await replayConnection.client.callTool("fetch_weather", { city: "busan" }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: { message?: string } },
    );
    expect(missed?.code).toBe("OPERATION_FAILED");
    expect(missed?.cause?.message).toContain("저장된 외부 응답을 찾지 못했습니다");
    expect(missed?.cause?.message).toContain("실제 네트워크는 호출하지 않았습니다");
    expect(originCalls).toBe(1);

    await replayConnection.close();
    expect(await replay.finish("completed")).toMatchObject({
      consumedCount: 1,
      unusedCount: 0,
    });
  }, 20_000);
});
