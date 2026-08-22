import type { FileHandle } from "node:fs/promises";
import { open, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadSession } from "@mcpeak/record/external";
import { validateMcpSuite } from "@mcpeak/runner";
import type {
  FileContent,
  FileEntry,
  PutFileResponse,
  SessionDetail,
  SessionInteraction,
} from "../api-types.js";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);

/**
 * SQLite 파일의 첫 16바이트. 이걸로 후보를 거른다.
 *
 * **확장자로 거르지 않는 이유가 있다.** CLI 의 `--record-session` 은 경로를 그대로 받으므로
 * 사용자가 확장자 없는 이름(`ㅋ`)을 줘도 녹화가 된다. 확장자로 거르면 그렇게 만든 세션이
 * 목록에서 통째로 사라지는데, 화면은 "녹화된 세션이 없습니다" 라고만 말해 사용자가 원인을
 * 찾을 길이 없다. 헤더는 16바이트만 읽으므로 모든 파일을 SQLite 로 열어 보는 것보다 싸다.
 */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** 첫 16바이트가 SQLite 헤더인지. 읽기 실패는 "아니다" 로 본다. */
async function hasSqliteHeader(absolute: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(SQLITE_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** 루트 아래 파일 절대경로 전부. `matches` 가 true 인 것만 담고, 제외 디렉터리는 안 내려간다. */
async function walkFiles(dir: string, matches: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      results.push(...(await walkFiles(join(dir, entry.name), matches)));
      continue;
    }
    if (entry.isFile() && matches(entry.name)) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

const walkJsonFiles = (dir: string): Promise<string[]> =>
  walkFiles(dir, (name) => name.toLowerCase().endsWith(".json"));

/** OS 구분자와 무관하게 항상 `/`로 이어진 상대경로를 준다. */
function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/** `**\/*.json` 중 `validateMcpSuite`를 통과하는 파일만 목록에 담는다. */
export async function listSuites(root: string): Promise<FileEntry[]> {
  const files = await walkJsonFiles(root);
  const results: FileEntry[] = [];
  for (const absolute of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
      if (validateMcpSuite(parsed).valid) results.push({ path: toRelative(root, absolute) });
    } catch {
      // 무효 JSON·읽기 실패는 조용히 제외한다. 목록은 유효한 것만 보여준다.
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 세션 파일 후보 중 `loadSession` 이 인정하는 것만 목록에 담는다.
 *
 * 판별을 `record` 에 맡기는 것이 핵심이다. 여기서 스키마를 직접 열어 보면 세션 형식이
 * 바뀔 때 대시보드가 조용히 어긋난다 — 카세트 목록이 `loadCassette` 를 쓴 것과 같은 이유다.
 */
export async function listSessions(root: string): Promise<FileEntry[]> {
  const files = await walkFiles(root, () => true);
  const results: FileEntry[] = [];
  for (const absolute of files) {
    // 헤더로 먼저 거르고, 최종 판정만 `loadSession` 에 맡긴다. `loadSession` 은 세션이
    // 아니면 null 을 주고(던지지 않는다) 읽기 전용이라 훑는 것만으로 파일이 생기지 않는다.
    if (!(await hasSqliteHeader(absolute))) continue;
    if (loadSession(absolute) !== null) results.push({ path: toRelative(root, absolute) });
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/** 세션 하나를 화면이 그릴 모양으로 옮긴다. 세션이 아니면 null(호출부가 404로 옮긴다). */
export function readSessionDetail(root: string, absolute: string): SessionDetail | null {
  const snapshot = loadSession(absolute);
  if (snapshot === null) return null;
  const interactions: SessionInteraction[] = snapshot.interactions.map((interaction) => ({
    ordinal: interaction.ordinal,
    occurrence: interaction.occurrence,
    recordedAt: interaction.recordedAt,
    status: interaction.status,
    method: interaction.request.display.method,
    url: interaction.request.display.url,
    responseStatus: interaction.outcome?.kind === "response" ? interaction.outcome.status : null,
    threw: interaction.outcome !== undefined && interaction.outcome.kind !== "response",
  }));
  return {
    path: toRelative(root, absolute),
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    interactions,
  };
}

/** 세션 파일을 지운다. 파일이 없으면 던진다(호출부가 404로 옮긴다). */
export async function deleteSessionFile(absolute: string): Promise<void> {
  await rm(absolute);
}

/** 파일을 읽어 `FileContent`로 준다. 파일이 없으면 던진다(호출부가 404로 옮긴다). */
export async function readFileContent(root: string, absolute: string): Promise<FileContent> {
  const [content, stats] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
  return { path: toRelative(root, absolute), content, mtimeMs: stats.mtimeMs };
}

/**
 * mtime이 기대값과 다르면 파일을 건드리지 않고 `conflict`를 준다. 파일이 아직 없으면
 * (신규 저장) 충돌이 아니라고 본다.
 */
export async function writeFileContent(
  absolute: string,
  content: string,
  baseMtimeMs: number,
): Promise<PutFileResponse> {
  const currentMtimeMs = await stat(absolute)
    .then((stats) => stats.mtimeMs)
    .catch(() => baseMtimeMs);
  if (currentMtimeMs !== baseMtimeMs) {
    return { saved: false, reason: "conflict", mtimeMs: currentMtimeMs };
  }
  await writeFile(absolute, content, "utf8");
  const stats = await stat(absolute);
  return { saved: true, mtimeMs: stats.mtimeMs };
}
