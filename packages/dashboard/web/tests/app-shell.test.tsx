// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

/** 화면들이 마운트 시 부르는 GET을 전부 빈 목록으로 응답하는 fetch fake. */
function fakeFetch(): typeof fetch {
  return vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
}

const NAV_LABELS = ["Home", "Runs", "Generate", "Record", "Repair"];

describe("app shell", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fakeFetch());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("사이드바 라벨이 순서대로 Home, Runs, Generate, Record, Repair다", async () => {
    window.location.hash = "#/home";
    render(<App />);
    const nav = await screen.findByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent?.trim());
    expect(links).toEqual(NAV_LABELS);
  });

  it("사이드바 로고가 제품명 MCPeak을 쓴다", async () => {
    window.location.hash = "#/home";
    render(<App />);
    const nav = await screen.findByRole("navigation");
    // 개명(ADR-0050) 이후 남아 있던 옛 이름이 화면에 노출되던 자리다.
    expect(nav.textContent).toContain("MCPeak");
    expect(nav.textContent).not.toContain("OhMyMCP");
  });

  it("해시가 비어 있으면 #/home으로 온다", async () => {
    window.location.hash = "";
    render(<App />);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/home");
    });
    expect(await screen.findByRole("heading", { name: "홈" })).toBeTruthy();
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.trim()).toBe("Home");
  });
});
