import type { IncomingMessage, ServerResponse } from "node:http";
import { validateMcpSuite } from "@mcpeak/runner";
import type {
  AnswerRequest,
  ApiError,
  PutFileRequest,
  StartRunRequest,
  StartRunResponse,
} from "../api-types.js";
import {
  deleteSessionFile,
  listSessions,
  listSuites,
  readFileContent,
  readSessionDetail,
  writeFileContent,
} from "./files.js";
import { resolveProjectPath } from "./paths.js";
import type { RunIo, RunRegistry } from "./run-registry.js";
import { formatSseEvent, formatSseEvents, SSE_HEADERS } from "./sse.js";
import { serveStatic } from "./static.js";
import { executeFlow } from "./wiring.js";

export interface RouterOptions {
  readonly root: string;
  readonly webDist: string;
  readonly registry: RunRegistry;
  /**
   * flow 실행기. 기본값은 `wiring.ts`의 실제 `executeFlow`다. 테스트가 실제 커맨드
   * 함수(서버 연결·프로세스 기동)를 돌리지 않고 fake로 바꿔치기할 수 있도록 연다.
   */
  readonly execute?: (request: StartRunRequest, io: RunIo) => Promise<number>;
}

const RUN_FLOWS = new Set<StartRunRequest["flow"]>(["test", "generate", "repair"]);

/**
 * 계획서 §4-4 HTTP 면 표를 전부 연결한다. 매칭되는 경로가 없으면 정적 서빙으로 넘긴다
 * (SPA는 `/` 아래 아무 경로나 받아 index.html로 fallback해야 하므로, `/api` 밖은
 * 전부 static.ts 몫이다).
 */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RouterOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/api/suites") {
    sendJson(response, 200, await listSuites(options.root));
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/suites/")) {
    await handleGetFile(response, options.root, decodeParam(pathname, "/api/suites/"));
    return;
  }
  if (method === "PUT" && pathname.startsWith("/api/suites/")) {
    await handlePutFile(request, response, options.root, decodeParam(pathname, "/api/suites/"));
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    sendJson(response, 200, await listSessions(options.root));
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/sessions/")) {
    handleGetSession(response, options.root, decodeParam(pathname, "/api/sessions/"));
    return;
  }
  if (method === "DELETE" && pathname.startsWith("/api/sessions/")) {
    await handleDeleteSession(response, options.root, decodeParam(pathname, "/api/sessions/"));
    return;
  }
  if (method === "POST" && pathname === "/api/runs") {
    await handleStartRun(request, response, options.registry, options.execute ?? executeFlow);
    return;
  }
  if (method === "GET" && pathname === "/api/runs") {
    sendJson(response, 200, options.registry.list());
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/runs/") && pathname.endsWith("/events")) {
    handleRunEvents(request, response, options.registry, extractRunId(pathname, "/events"));
    return;
  }
  if (method === "POST" && pathname.startsWith("/api/runs/") && pathname.endsWith("/answer")) {
    await handleAnswer(request, response, options.registry, extractRunId(pathname, "/answer"));
    return;
  }
  if (method === "GET" && pathname.startsWith("/api/runs/")) {
    handleGetRun(response, options.registry, pathname.slice("/api/runs/".length));
    return;
  }
  if (pathname.startsWith("/api/")) {
    const error: ApiError = { error: `그런 경로가 없습니다: ${method} ${pathname}` };
    sendJson(response, 404, error);
    return;
  }

  await serveStatic(request, response, options.webDist, pathname);
}

function decodeParam(pathname: string, prefix: string): string | null {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function extractRunId(pathname: string, suffix: string): string {
  const prefix = "/api/runs/";
  const withoutSuffix = pathname.slice(0, pathname.length - suffix.length);
  const raw = withoutSuffix.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function handleGetFile(
  response: ServerResponse,
  root: string,
  relativeOrNull: string | null,
): Promise<void> {
  if (relativeOrNull === null) {
    sendJson(response, 400, { error: "경로를 해석할 수 없습니다." });
    return;
  }
  const absolute = resolveProjectPath(root, relativeOrNull);
  if (absolute === null) {
    sendJson(response, 400, { error: "허용되지 않는 경로입니다." });
    return;
  }
  try {
    const content = await readFileContent(root, absolute);
    sendJson(response, 200, content);
  } catch {
    sendJson(response, 404, { error: "파일을 찾을 수 없습니다." });
  }
}

/**
 * 세션 상세. 세션 파일이 아니거나 없으면 404 다 — 판별은 `record` 의 `loadSession` 이 한다.
 * 동기 함수인 것은 `node:sqlite` 가 동기 API 라서다.
 */
function handleGetSession(
  response: ServerResponse,
  root: string,
  relativeOrNull: string | null,
): void {
  const absolute = resolveGuardedPath(response, root, relativeOrNull);
  if (absolute === null) return;
  const detail = readSessionDetail(root, absolute);
  if (detail === null) {
    sendJson(response, 404, { error: "세션 파일을 찾을 수 없습니다." });
    return;
  }
  sendJson(response, 200, detail);
}

async function handleDeleteSession(
  response: ServerResponse,
  root: string,
  relativeOrNull: string | null,
): Promise<void> {
  const absolute = resolveGuardedPath(response, root, relativeOrNull);
  if (absolute === null) return;
  // 지우기 전에 세션인지 확인한다. 경로만 맞으면 무엇이든 지워 주면, 이 API 가 프로젝트
  // 안의 아무 파일이나 지우는 수단이 된다.
  if (readSessionDetail(root, absolute) === null) {
    sendJson(response, 404, { error: "세션 파일을 찾을 수 없습니다." });
    return;
  }
  try {
    await deleteSessionFile(absolute);
    response.writeHead(204);
    response.end();
  } catch (error) {
    if (isErrno(error, "EACCES")) {
      sendJson(response, 400, {
        error: "삭제 권한이 없습니다. 파일 또는 상위 디렉터리의 권한을 확인하세요.",
      });
      return;
    }
    throw error;
  }
}

/**
 * 경로를 해석하고 루트 밖 접근을 막는다. 막힌 경우 응답을 직접 보내고 `null` 을 준다.
 * 세션 경로 핸들러 셋이 같은 두 검사를 반복하던 것을 한자리로 모은 것이다.
 */
function resolveGuardedPath(
  response: ServerResponse,
  root: string,
  relativeOrNull: string | null,
): string | null {
  if (relativeOrNull === null) {
    sendJson(response, 400, { error: "경로를 해석할 수 없습니다." });
    return null;
  }
  const absolute = resolveProjectPath(root, relativeOrNull);
  if (absolute === null) {
    sendJson(response, 400, { error: "허용되지 않는 경로입니다." });
    return null;
  }
  return absolute;
}

async function handlePutFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  relativeOrNull: string | null,
): Promise<void> {
  if (relativeOrNull === null) {
    sendJson(response, 400, { error: "경로를 해석할 수 없습니다." });
    return;
  }
  const absolute = resolveProjectPath(root, relativeOrNull);
  if (absolute === null) {
    sendJson(response, 400, { error: "허용되지 않는 경로입니다." });
    return;
  }
  if (!relativeOrNull.toLowerCase().endsWith(".json")) {
    sendJson(response, 400, { error: "스위트는 .json 확장자 파일만 저장할 수 있습니다." });
    return;
  }
  const body = await readJsonBody<Partial<PutFileRequest>>(request);
  if (body === undefined) {
    sendJson(response, 400, { error: "본문이 올바른 JSON이 아닙니다." });
    return;
  }
  if (typeof body.content !== "string" || typeof body.baseMtimeMs !== "number") {
    sendJson(response, 400, { error: "content·baseMtimeMs가 필요합니다." });
    return;
  }
  const validationError = await validateFileContent(body.content);
  if (validationError !== null) {
    sendJson(response, 400, { error: validationError });
    return;
  }
  try {
    const result = await writeFileContent(absolute, body.content, body.baseMtimeMs);
    sendJson(response, 200, result);
  } catch (error) {
    const message = writeErrorMessage(error);
    if (message !== null) {
      sendJson(response, 400, { error: message });
      return;
    }
    throw error;
  }
}

function isStartRunRequest(value: unknown): value is StartRunRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.flow !== "string" || !RUN_FLOWS.has(record.flow as StartRunRequest["flow"])) {
    return false;
  }
  if (!Array.isArray(record.argv)) return false;
  return record.argv.every((item) => typeof item === "string");
}

async function handleStartRun(
  request: IncomingMessage,
  response: ServerResponse,
  registry: RunRegistry,
  execute: (request: StartRunRequest, io: RunIo) => Promise<number>,
): Promise<void> {
  const body = await readJsonBody<unknown>(request);
  if (body === undefined) {
    sendJson(response, 400, { error: "본문이 올바른 JSON이 아닙니다." });
    return;
  }
  if (!isStartRunRequest(body)) {
    sendJson(response, 400, { error: "flow·argv 형식이 올바르지 않습니다." });
    return;
  }
  const startRequest = body;
  const handle = registry.start(startRequest.flow, (io) => execute(startRequest, io));
  const result: StartRunResponse = { runId: handle.runId };
  sendJson(response, 200, result);
}

function handleGetRun(response: ServerResponse, registry: RunRegistry, runId: string): void {
  let decodedRunId = runId;
  try {
    decodedRunId = decodeURIComponent(runId);
  } catch {
    // 그대로 조회를 시도한다. 못 찾으면 404다.
  }
  const handle = registry.get(decodedRunId);
  if (handle === undefined) {
    sendJson(response, 404, { error: "그런 run이 없습니다." });
    return;
  }
  sendJson(response, 200, handle.summary);
}

/**
 * SSE 구독. 과거 이벤트를 동기 구간에서 먼저 흘려보낸 뒤 바로 구독한다. 그 사이에는
 * `await`가 없어 다른 이벤트가 끼어들 여지가 없다(중복·누락 방지, 계획서 §5 T2 사양).
 */
function handleRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  registry: RunRegistry,
  runId: string,
): void {
  const handle = registry.get(runId);
  if (handle === undefined) {
    sendJson(response, 404, { error: "그런 run이 없습니다." });
    return;
  }
  const header = request.headers["last-event-id"];
  const lastEventId = parseLastEventId(Array.isArray(header) ? header[0] : header);
  response.writeHead(200, SSE_HEADERS);
  response.write(formatSseEvents(handle.events.filter((event) => event.id > lastEventId)));
  const unsubscribe = handle.subscribe((event) => {
    response.write(formatSseEvent(event));
  });
  response.on("close", unsubscribe);
}

function parseLastEventId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return 0;
  return Number(value);
}

async function validateFileContent(content: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return "본문 content가 올바른 JSON이 아닙니다.";
  }
  return validateMcpSuite(parsed).valid ? null : "본문 content가 올바른 MCP 스위트가 아닙니다.";
}

function isErrno(error: unknown, code: "ENOENT" | "EISDIR" | "EACCES"): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function writeErrorMessage(error: unknown): string | null {
  if (isErrno(error, "ENOENT"))
    return "상위 디렉터리가 없습니다. 먼저 디렉터리를 만든 뒤 다시 저장하세요.";
  if (isErrno(error, "EISDIR")) return "저장 대상이 디렉터리입니다. 파일 경로를 선택하세요.";
  if (isErrno(error, "EACCES"))
    return "쓰기 권한이 없습니다. 파일 또는 상위 디렉터리의 쓰기 권한을 확인하세요.";
  return null;
}

async function handleAnswer(
  request: IncomingMessage,
  response: ServerResponse,
  registry: RunRegistry,
  runId: string,
): Promise<void> {
  const handle = registry.get(runId);
  if (handle === undefined) {
    sendJson(response, 404, { error: "그런 run이 없습니다." });
    return;
  }
  const body = await readJsonBody<Partial<AnswerRequest>>(request);
  if (body === undefined) {
    sendJson(response, 400, { error: "본문이 올바른 JSON이 아닙니다." });
    return;
  }
  if (typeof body.questionId !== "string" || typeof body.value !== "string") {
    sendJson(response, 400, { error: "questionId·value가 필요합니다." });
    return;
  }
  const answered = handle.reviewIO.answer(body.questionId, body.value);
  if (!answered) {
    sendJson(response, 409, {
      error: "대기 중인 질문이 없거나 questionId가 일치하지 않습니다.",
    });
    return;
  }
  response.writeHead(204);
  response.end();
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
