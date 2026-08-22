import type { JSX } from "react";

/**
 * 좌측 고정 사이드바(248px). UI 설계 §2: 로고 블록 + 내비 5항목(영어 라벨,
 * 인라인 SVG stroke 아이콘) + 하단 서버 주소(`location.host`, mono).
 * 활성 항목은 `aria-current="page"` 하나로 표시하고 스타일도 그 속성을 본다.
 */
export type NavId = "home" | "runs" | "generate" | "record" | "repair";

interface NavItem {
  readonly id: NavId;
  readonly label: string;
  readonly hash: string;
  readonly icon: JSX.Element;
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "home",
    label: "Home",
    hash: "#/home",
    icon: (
      // biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접
      <svg {...ICON_PROPS}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5" />
      </svg>
    ),
  },
  {
    id: "runs",
    label: "Runs",
    hash: "#/runs",
    icon: (
      // biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접
      <svg {...ICON_PROPS}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    id: "generate",
    label: "Generate",
    hash: "#/generate",
    icon: (
      // biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접
      <svg {...ICON_PROPS}>
        <path d="M12 3v18" />
        <path d="M3 12h18" />
      </svg>
    ),
  },
  {
    id: "record",
    label: "Record",
    hash: "#/record",
    icon: (
      // biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    ),
  },
  {
    id: "repair",
    label: "Repair",
    hash: "#/repair",
    icon: (
      // biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접
      <svg {...ICON_PROPS}>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.7-2.7 2.4-3z" />
      </svg>
    ),
  },
];

export function Sidebar({ active }: { readonly active: NavId }): JSX.Element {
  return (
    <nav className="flex w-[248px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-3 px-5 py-5">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white"
          style={{ background: "linear-gradient(135deg, #8b5cf6, #6d28d9)" }}
          aria-hidden
        >
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: 장식용 아이콘, 라벨 텍스트가 인접 */}
          <svg {...ICON_PROPS}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-ink">MCPeak</p>
          <p className="text-xs text-ink-muted">MCP Test Dashboard</p>
        </div>
      </div>
      <ul className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <a
              href={item.hash}
              aria-current={item.id === active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                item.id === active
                  ? "bg-accent-soft font-semibold text-accent"
                  : "font-medium text-ink-muted hover:bg-line-subtle hover:text-ink"
              }`}
            >
              {item.icon}
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-5 py-4 font-mono text-xs text-ink-muted">
        {window.location.host}
      </p>
    </nav>
  );
}
