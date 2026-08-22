import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { NavId } from "./components/Sidebar.js";
import { Sidebar } from "./components/Sidebar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { GenerateWizard } from "./screens/GenerateWizard.js";
import { Home } from "./screens/Home.js";
import { RecordBrowser } from "./screens/RecordBrowser.js";
import { RepairReview } from "./screens/RepairReview.js";
import { RunView } from "./screens/RunView.js";

/**
 * 해시 라우팅(구현계획 §4-3). 라우터 의존성 없이 `location.hash`만 본다.
 *
 * | 라우트 | 화면 |
 * |---|---|
 * | `#/home` (기본 리다이렉트 대상) | Home |
 * | `#/runs`, `#/runs/:id` | RunView (`#/runs`는 목록 상태) |
 * | `#/generate` | GenerateWizard |
 * | `#/repair/:id` | RepairReview |
 *
 */
type Route =
  | { readonly screen: "home" }
  | { readonly screen: "runs"; readonly runId: string | null }
  | { readonly screen: "generate" }
  | { readonly screen: "record"; readonly path: string | null }
  | { readonly screen: "repair"; readonly runId: string | null }
  | { readonly screen: "redirect" };

/** 잘못된 인코딩(%zz 등)이 화면을 깨뜨리지 않게 한다. origin f9198e0 계승. */
function decodeRouteValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * `#/runs/<runId>`, `#/repair/<runId>` 처럼 첫 세그먼트가 화면을, 그
 * 뒤가 식별자를 가리키는 해시를 해석한다. 식별자가 없으면 null이다(예: `#/runs`만
 * 있으면 실행 화면이지만 아직 특정 run을 보는 중은 아니다).
 */
function parseRoute(hash: string): Route {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = withoutHash.split("/").filter((segment) => segment.length > 0);
  const [first, ...rest] = segments;

  if (first === "home") {
    return { screen: "home" };
  }
  if (first === "runs") {
    return { screen: "runs", runId: rest[0] !== undefined ? decodeRouteValue(rest[0]) : null };
  }
  if (first === "generate") {
    return { screen: "generate" };
  }
  if (first === "record") {
    // 세션 경로는 `/` 를 품으므로 인코딩된 한 세그먼트다. 옛 `#/cassettes/<path>` 와 같은 규약.
    return { screen: "record", path: rest[0] !== undefined ? decodeRouteValue(rest[0]) : null };
  }
  if (first === "repair") {
    return {
      screen: "repair",
      runId: rest[0] !== undefined ? decodeRouteValue(rest[0]) : null,
    };
  }
  // 빈 해시·알 수 없는 해시는 #/home으로 보낸다(§4-3 기본 리다이렉트).
  return { screen: "redirect" };
}

const HEADER_TITLES: Record<NavId, string> = {
  home: "Home",
  runs: "Runs",
  generate: "Generate",
  record: "Record",
  repair: "Repair",
};

export function App(): JSX.Element {
  const [hash, setHash] = useState<string>(() => window.location.hash);

  useEffect(() => {
    const onHashChange = (): void => {
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return (): void => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const route = parseRoute(hash);

  useEffect(() => {
    if (route.screen === "redirect") {
      window.location.hash = "#/home";
      setHash("#/home");
    }
  }, [route.screen]);

  if (route.screen === "redirect") {
    return <div className="min-h-screen bg-canvas" />;
  }

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <Sidebar active={route.screen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-surface px-6">
          <p className="text-sm font-semibold text-ink">{HEADER_TITLES[route.screen]}</p>
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 p-8">
          <Screen route={route} />
        </main>
      </div>
    </div>
  );
}

function Screen({
  route,
}: {
  readonly route: Exclude<Route, { screen: "redirect" }>;
}): JSX.Element {
  switch (route.screen) {
    case "home":
      return <Home />;
    case "runs":
      return <RunView runId={route.runId} />;
    case "generate":
      return <GenerateWizard />;
    case "record":
      return <RecordBrowser path={route.path} />;
    case "repair":
      return <RepairReview runId={route.runId} />;
  }
}
