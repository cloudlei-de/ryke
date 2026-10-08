// Small pieces every view draws with: the icon set, the state pill and the theme switch. Icons are drawn
// here rather than taken from a library (PLAN.md §0.7): 24-unit paths, stroked in the current colour.
import { useEffect, useState, type ReactNode } from "react";
import type { Signal } from "./views/txn/format";

const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  alert: "M12 4L2.8 19.5h18.4L12 4zM12 10v4.2M12 16.9v.1",
  retry: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2",
  clock: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2",
  user: "M12 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5",
  commit: "M12 8.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4zM3 12h5.8M15.2 12H21",
  train: "M12 4l8.5 4.3L12 12.6 3.5 8.3zM3.5 12.2l8.5 4.3 8.5-4.3M3.5 16l8.5 4.3 8.5-4.3",
  play: "M8 5.8v12.4l10-6.2z",
  pause: "M8 5.5v13M16 5.5v13",
  first: "M6.5 5.5v13M18 6l-8 6 8 6z",
  last: "M17.5 5.5v13M6 6l8 6-8 6z",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z",
  system: "M4 5h16v11H4zM9 20h6M12 16v4",
  undo: "M9 6.5L4.5 11 9 15.5M5 11h9.5a5 5 0 0 1 0 10H11",
  external: "M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10",
  copy: "M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9",
  file: "M6.5 3.5H14l4 4v13H6.5zM14 3.5v4h4",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  flame: "M12 3.5c.8 3.2 4.8 5 4.8 9.7a4.8 4.8 0 0 1-9.6 0c0-2.4 1.3-3.8 2.3-4.8.3 1.7.9 2.6 1.8 3C11 9 11 6.2 12 3.5z",
  ban: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM6 6l12 12",
  back: "M19 12H5.5M11 6l-6 6 6 6",
  info: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.2M12 7.9v.1",
  tests: "M9 3.5h6M10 3.5v5.8L5.2 18.4a1.5 1.5 0 0 0 1.3 2.1h11a1.5 1.5 0 0 0 1.3-2.1L14 9.3V3.5M7.5 15h9",
  image: "M4 5h16v14H4zM4 16l4.5-4.5 4 4 2.5-2.5L20 18M15.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  bolt: "M13 3L5.5 13.5h5.5L10 21l8-10.5h-5.5z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z",
  shield: "M12 3.5l7.5 3V12c0 4.3-3.1 7.6-7.5 9-4.4-1.4-7.5-4.7-7.5-9V6.5z",
  spark: "M12 3.5l1.9 5.3 5.6 1.2-4.4 3.6.9 5.9L12 16.6l-4 2.9.9-5.9L4.5 10l5.6-1.2z",
  pulse: "M3 12h4l2.5-6 5 12 2.5-6h4",
  chevron: "M6 9l6 6 6-6",
  repo: "M6 3.5h12v17H6zM6 16.5h12M9.5 7h5M9.5 10.5h5",
  hourglass: "M7 3.5h10M7 20.5h10M8 3.5c0 4.5 8 4.5 8 8.5s-8 4-8 8.5M16 3.5c0 4.5-8 4.5-8 8.5s8 4 8 8.5",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1",
  git: "M6 4.5v15M6 8.5c0 4.5 12 3 12 9M18 17.5v2",
} as const;
export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set(["play"]);

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

// The mark in the top bar: a main line with a siding joining it, the gesture the Line is built on.
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6.5" fill="var(--text)" />
      <path d="M5 8.5h14" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M5 16.5h4.2c1.6 0 2.4-.5 3.3-1.8l2.2-3.6c.8-1.4 1.5-2.6 3.3-2.6" stroke="var(--go)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

const STATE_ICON: Record<string, IconName> = {
  open: "pulse",
  submitted: "hourglass",
  ready: "hourglass",
  verifying: "tests",
  landed: "check",
  stale: "retry",
  failed: "x",
  rejected: "ban",
  needs_human: "user",
  aborted: "x",
  recalled: "undo",
};

export function stateIcon(state: string): IconName {
  return STATE_ICON[state] ?? "pulse";
}

export function Pill({ tone, icon, children, large }: { tone: Signal | null; icon?: IconName; children: ReactNode; large?: boolean }) {
  return (
    <span className={large ? "pill pill-lg" : "pill"} data-tone={tone && tone !== "none" ? tone : undefined}>
      {icon && <Icon name={icon} size={large ? 14 : 12} />}
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ theme

export type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_KEY = "ryke.theme";

export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!;
}

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

// `data-theme` on <html> is what styles.css switches on; "system" removes it so the media query decides.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage blocked: the choice lasts for this page view
    }
  }, [theme]);
  return [theme, () => setTheme(nextTheme)];
}

export const THEME_ICON: Record<Theme, IconName> = { system: "system", light: "sun", dark: "moon" };
